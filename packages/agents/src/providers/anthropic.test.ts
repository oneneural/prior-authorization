import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type Anthropic from '@anthropic-ai/sdk';
import { MemorySaver } from '@langchain/langgraph';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AdmissionRefused, AdmissionUnavailable, type AdmissionPort } from '../admission/port.js';
import { attemptCeilingUnits, OPUS_5_5_TARIFF, usageUnits } from '../admission/units.js';
import { DEFAULT_LIMITS } from '../config.js';
import { agentVersions, startInvestigation } from '../graph.js';
import { TOOL_INPUTS, TOOL_NAMES, type ToolPort } from '../tools.js';
import {
  BudgetExhausted, createAnthropicProvider, LIVE_MODEL_DEFAULTS, LiveProviderDisabled, LiveProviderFailure, LiveProviderUnavailable, LiveTranscriptMismatch,
  reviewOnlyLiveProvider, sdkLiveClient, unavailableLiveClient, usageOf, type LiveModelClient,
} from './anthropic.js';
import { LIVE_TOOLS } from './live-tools.js';

const context = (observations: { tool: string; outcome: string; result: unknown }[] = [], turn = 0) => ({ turn, observations, signal: new AbortController().signal });

type Usage = Partial<Anthropic.Usage>;
function message(stop_reason: Anthropic.StopReason, content: unknown[], usage: Usage | null = { input_tokens: 1000, output_tokens: 100 }, stop_details: unknown = null): Anthropic.Message {
  return {
    id: `msg_${randomUUID()}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, stop_details,
    usage: usage === null ? undefined : { cache_creation_input_tokens: 0, cache_read_input_tokens: 0, ...usage },
  } as unknown as Anthropic.Message;
}
const toolUse = (name: string, input: unknown, id = `toolu_${randomUUID().slice(0, 8)}`) => ({ type: 'tool_use', id, name, input });
const thinking = { type: 'thinking', thinking: '', signature: 'sig-opaque' };

/** One shared event log, so tests can assert the order of admission and provider requests. */
let events: string[] = [];

/** A fake client that returns scripted messages and keeps a copy of each request. */
function fakeClient(responses: (Anthropic.Message | Error)[]) {
  const requests: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const create = vi.fn((params: Anthropic.MessageCreateParamsNonStreaming) => {
    events.push('create');
    requests.push(structuredClone(params));
    const next = responses.shift();
    if (next === undefined || next instanceof Error) return Promise.reject(next ?? new Error('no scripted response'));
    return Promise.resolve(next);
  });
  const client: LiveModelClient = { create };
  return { client, requests, create };
}

const CEILING = attemptCeilingUnits(OPUS_5_5_TARIFF, LIVE_MODEL_DEFAULTS.maxOutputTokens);

/**
 * Transport fake for the API admission routes: it records each operation and
 * grants unless a test overrides one. The ledger rules themselves are tested
 * against the real API implementation in apps/api.
 */
function fakeAdmission(overrides: Partial<AdmissionPort> = {}) {
  const reserve: AdmissionPort['reserve'] = (request) => {
    events.push(`reserve:${request.turn}`);
    return Promise.resolve({ attemptId: randomUUID(), state: 'reserved', reservedUnits: CEILING, replayed: false });
  };
  const dispatch: AdmissionPort['dispatch'] = (attemptId) => { events.push('dispatch'); return Promise.resolve({ attemptId, state: 'dispatching', writerGeneration: 1 }); };
  const release: AdmissionPort['release'] = (attemptId) => { events.push('release'); return Promise.resolve({ attemptId, state: 'released', actualUnits: null }); };
  const reconcile: AdmissionPort['reconcile'] = (attemptId, report) => {
    events.push('reconcile');
    return Promise.resolve({ attemptId, state: 'reconciled', actualUnits: usageUnits(OPUS_5_5_TARIFF, report.usage) });
  };
  const unknown: AdmissionPort['unknown'] = (attemptId) => { events.push('unknown'); return Promise.resolve({ attemptId, state: 'unknown', actualUnits: null }); };
  const logged = <K extends keyof AdmissionPort>(name: K, fallback: AdmissionPort[K]): AdmissionPort[K] => {
    const override = overrides[name];
    if (override === undefined) return vi.fn(fallback) as unknown as AdmissionPort[K];
    return vi.fn((...args: Parameters<AdmissionPort[K]>) => { events.push(name); return (override as (...a: Parameters<AdmissionPort[K]>) => ReturnType<AdmissionPort[K]>)(...args); }) as unknown as AdmissionPort[K];
  };
  return {
    reserve: logged('reserve', reserve), dispatch: logged('dispatch', dispatch), release: logged('release', release),
    reconcile: logged('reconcile', reconcile), unknown: logged('unknown', unknown),
  } satisfies AdmissionPort;
}

const provider = (client: LiveModelClient, admission = fakeAdmission()) => createAnthropicProvider(LIVE_MODEL_DEFAULTS, { admission, clientFactory: () => client });

beforeEach(() => { events = []; });

describe('live Claude boundary', () => {
  it('constructs the client, reading the key, before any admission call, and refuses unusable keys', async () => {
    const admission = fakeAdmission();
    const factory = vi.fn(unavailableLiveClient);
    expect(() => createAnthropicProvider(LIVE_MODEL_DEFAULTS, { admission, clientFactory: factory })).toThrow(LiveProviderDisabled);
    expect(factory).toHaveBeenCalledTimes(1);
    const dir = await mkdtemp(join(tmpdir(), 'pa-key-'));
    const empty = join(dir, 'empty');
    const unreadable = join(dir, 'unreadable');
    await writeFile(empty, '\n');
    await writeFile(unreadable, 'sk-ant-synthetic-not-a-key');
    await chmod(unreadable, 0o000);
    for (const file of [join(dir, 'missing'), empty, ...(process.getuid?.() === 0 ? [] : [unreadable])]) {
      expect(() => createAnthropicProvider(LIVE_MODEL_DEFAULTS, { admission, clientFactory: sdkLiveClient(file) })).toThrow(LiveProviderUnavailable);
    }
    for (const operation of Object.values(admission)) expect(operation).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it('resumes review with the live version but constructs no client and permits no model turn', async () => {
    const review = reviewOnlyLiveProvider(LIVE_MODEL_DEFAULTS);
    const live = provider(fakeClient([]).client);
    expect(review.version).toBe(live.version);
    expect(review.identity).toEqual(live.identity);
    await expect(review.next(context())).rejects.toThrow(LiveProviderDisabled);
  });

  it('declares exactly the allowlisted tools as strict schemas', () => {
    expect(LIVE_TOOLS.map((tool) => tool.name)).toEqual([...TOOL_NAMES].sort());
    for (const tool of LIVE_TOOLS) {
      expect(tool.strict).toBe(true);
      expect(tool.input_schema).toMatchObject({ type: 'object', additionalProperties: false });
      expect(Object.keys(TOOL_INPUTS[tool.name as keyof typeof TOOL_INPUTS].shape).sort()).toEqual(Object.keys(tool.input_schema.properties ?? {}).sort());
    }
  });

  it('sends cached, effort-set requests with auto tool choice and maps tool use, results and finish', async () => {
    const { client, requests } = fakeClient([
      message('tool_use', [thinking, toolUse('read_document', { documentId: 'doc-1', version: 1 }, 'toolu_a')], { input_tokens: 1000, output_tokens: 100, cache_creation_input_tokens: 2000, cache_read_input_tokens: 0 }),
      message('end_turn', [thinking, { type: 'text', text: 'done' }], { input_tokens: 50, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 3000 }),
    ]);
    const live = provider(client);
    expect(live.identity).toEqual({ provider: 'anthropic', model: 'claude-opus-5-5', label: 'live_claude', recordingSha256: null });
    await expect(live.next(context())).resolves.toEqual({ type: 'call_tool', tool: 'read_document', input: { documentId: 'doc-1', version: 1 } });
    const observation = { tool: 'read_document', outcome: 'ok', result: { payload: 'synthetic' } };
    await expect(live.next(context([observation], 1))).resolves.toEqual({ type: 'finish' });

    const [first, second] = requests;
    expect(first).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 8192, output_config: { effort: 'medium' }, tool_choice: { type: 'auto', disable_parallel_tool_use: true }, cache_control: { type: 'ephemeral' } });
    expect(first!.system).toEqual([expect.objectContaining({ cache_control: { type: 'ephemeral' } })]);
    expect(first).not.toHaveProperty('thinking');
    expect(first).not.toHaveProperty('fallbacks');
    expect(first!.messages).toHaveLength(1);
    // The assistant turn goes back unchanged, thinking block included, then one matching tool result.
    expect(second!.messages[1]).toEqual({ role: 'assistant', content: [thinking, toolUse('read_document', { documentId: 'doc-1', version: 1 }, 'toolu_a')] });
    expect(second!.messages[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: JSON.stringify({ outcome: 'ok', result: { payload: 'synthetic' } }), is_error: false }] });

    expect(live.calls.map((call) => [call.outcome, call.tool])).toEqual([['tool_use', 'read_document'], ['finish', null]]);
    // Exact integer units: reservation, grant and one request, then usage, before each turn returns.
    expect(events).toEqual(['reserve:0', 'dispatch', 'create', 'reconcile', 'reserve:1', 'dispatch', 'create', 'reconcile']);
    expect(live.calls.map((call) => call.actualUnits)).toEqual([1000 * 40 + 2000 * 50 + 100 * 200, 50 * 40 + 3000 * 2 + 10 * 200]);
    expect(live.calls.map((call) => call.reservedUnits)).toEqual([CEILING, CEILING]);
    expect(CEILING).toBe(51_638_400);
  });

  it('marks failed tool outcomes as errors and refuses an observation history that differs from the transcript', async () => {
    const { client, requests } = fakeClient([message('tool_use', [toolUse('shell', { command: 'x' }, 'toolu_b')]), message('end_turn', [])]);
    const live = provider(client);
    await expect(live.next(context())).resolves.toEqual({ type: 'call_tool', tool: 'shell', input: { command: 'x' } });
    expect(live.calls[0]!.tool).toBe('unsupported_tool');
    await live.next(context([{ tool: 'unsupported_tool', outcome: 'unsupported_tool', result: null }], 1));
    expect(requests[1]!.messages[2]).toMatchObject({ content: [{ tool_use_id: 'toolu_b', is_error: true }] });
    await expect(provider(fakeClient([]).client).next(context([{ tool: 'list_documents', outcome: 'ok', result: {} }]))).rejects.toThrow(LiveTranscriptMismatch);
  });

  it('records refusal, truncation and unexpected stops as explicit failures without returning their tool calls', async () => {
    const { client } = fakeClient([
      message('refusal', [toolUse('read_document', { documentId: 'doc-1' })], undefined, { type: 'refusal', category: 'cyber', explanation: 'not kept' }),
      message('max_tokens', [toolUse('propose_facts', { candidates: [] })]),
      message('pause_turn', []),
    ]);
    const outputs = [];
    for (let index = 0; index < 3; index += 1) outputs.push(await provider(client).next(context()));
    expect(outputs).toEqual([{ type: 'provider_failure', reason: 'refusal' }, { type: 'provider_failure', reason: 'max_tokens' }, { type: 'provider_failure', reason: 'unexpected_stop' }]);
    expect(events.filter((item) => item === 'reconcile')).toHaveLength(3);
    // Two tool uses despite disabled parallel use: refused whole, no tool runs.
    const multiple = provider(fakeClient([message('tool_use', [toolUse('list_documents', {}), toolUse('get_policy_pack', {})])]).client);
    await expect(multiple.next(context())).resolves.toEqual({ type: 'provider_failure', reason: 'multiple_tools' });
  });

  it('holds the full reservation when usage is missing or the request fails, with exactly one request and no retry', async () => {
    const { client, create } = fakeClient([message('end_turn', [], null), new Error('timeout after send')]);
    const admission = fakeAdmission();
    const live = provider(client, admission);
    await expect(live.next(context())).resolves.toEqual({ type: 'finish' });
    expect(live.calls[0]).toMatchObject({ outcome: 'finish', usage: null, actualUnits: null, attemptState: 'unknown', reservedUnits: CEILING });
    const failing = provider(client, admission);
    await expect(failing.next(context())).rejects.toThrow(LiveProviderFailure);
    expect(failing.calls[0]).toMatchObject({ outcome: 'api_error', requested: true, actualUnits: null, attemptState: 'unknown', error: { type: 'Error', status: null } });
    expect(create).toHaveBeenCalledTimes(2);
    expect(events).toEqual(['reserve:0', 'dispatch', 'create', 'unknown', 'reserve:0', 'dispatch', 'create', 'unknown']);
  });

  it('sends nothing when admission refuses the reservation or the grant, or the grant acknowledgement is lost, releasing only an ungranted attempt', async () => {
    const { client, create } = fakeClient([]);
    const budget = provider(client, fakeAdmission({ reserve: () => Promise.reject(new AdmissionRefused('budget_exhausted', 'cap')) }));
    await expect(budget.next(context())).rejects.toThrow(BudgetExhausted);
    expect(budget.calls[0]).toMatchObject({ outcome: 'budget_refused', requested: false, reservedUnits: 0 });

    events = [];
    const busy = provider(client, fakeAdmission({ dispatch: () => Promise.reject(new AdmissionRefused('dispatch_busy', 'busy')) }));
    await expect(busy.next(context())).rejects.toThrow(AdmissionRefused);
    // No grant was issued, so the reservation is released.
    expect(events).toEqual(['reserve:0', 'dispatch', 'release']);
    expect(busy.calls[0]).toMatchObject({ outcome: 'admission_refused', attemptState: 'released', requested: false });

    events = [];
    // A lost grant acknowledgement: the ledger still shows `reserved`, so the release succeeds.
    const notGranted = provider(client, fakeAdmission({ dispatch: () => Promise.reject(new AdmissionUnavailable('no acknowledgement')) }));
    await expect(notGranted.next(context())).rejects.toThrow(AdmissionUnavailable);
    expect(events).toEqual(['reserve:0', 'dispatch', 'release']);
    expect(notGranted.calls[0]).toMatchObject({ outcome: 'admission_unavailable', attemptState: 'released', requested: false });

    // The grant was recorded, so the ledger refuses the release: held as unknown, never used.
    events = [];
    const granted = provider(client, fakeAdmission({
      dispatch: () => Promise.reject(new AdmissionUnavailable('no acknowledgement')),
      release: () => Promise.reject(new AdmissionRefused('dispatch_already_granted', 'dispatched')),
    }));
    await expect(granted.next(context())).rejects.toThrow(AdmissionUnavailable);
    expect(events).toEqual(['reserve:0', 'dispatch', 'release', 'unknown']);
    expect(granted.calls[0]).toMatchObject({ outcome: 'admission_unavailable', attemptState: 'unknown', requested: false });

    // An uncertain release is treated the same way.
    events = [];
    const uncertain = provider(client, fakeAdmission({
      dispatch: () => Promise.reject(new AdmissionUnavailable('no acknowledgement')),
      release: () => Promise.reject(new AdmissionUnavailable('no acknowledgement')),
    }));
    await expect(uncertain.next(context())).rejects.toThrow(AdmissionUnavailable);
    expect(events).toEqual(['reserve:0', 'dispatch', 'release', 'unknown']);
    expect(uncertain.calls[0]).toMatchObject({ outcome: 'admission_unavailable', attemptState: 'unknown', requested: false });

    const unreachable = provider(client, fakeAdmission({ reserve: () => Promise.reject(new AdmissionUnavailable('down')) }));
    await expect(unreachable.next(context())).rejects.toThrow(AdmissionUnavailable);
    expect(create).not.toHaveBeenCalled();
  });

  it('settles an attempt abandoned by the graph deadline as unknown before reporting', async () => {
    let finish: (() => void) | undefined;
    const client: LiveModelClient = {
      create: (_params, signal) => new Promise((_resolve, reject) => {
        events.push('create');
        finish = () => reject(new Error('late failure'));
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    };
    const live = provider(client);
    const controller = new AbortController();
    const pending = live.next({ turn: 0, observations: [], signal: controller.signal });
    await vi.waitFor(() => expect(events).toContain('create'));
    controller.abort();
    finish?.();
    await expect(pending).rejects.toThrow(LiveProviderFailure);
    await live.settle();
    expect(events).toEqual(['reserve:0', 'dispatch', 'create', 'unknown']);
  });

  it('reports every billed class, so surcharged usage cannot be priced as standard', () => {
    const base = message('end_turn', [], { input_tokens: 10, output_tokens: 2, cache_creation_input_tokens: 3, cache_read_input_tokens: 4 });
    expect(usageOf(base)).toEqual({ inputTokens: 10, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4, cacheWrite1hInputTokens: 0, serverToolRequests: 0, serviceTier: null, inferenceGeo: null });
    const surcharged = message('end_turn', [], {
      input_tokens: 10, output_tokens: 2, cache_creation: { ephemeral_1h_input_tokens: 5, ephemeral_5m_input_tokens: 0 }, server_tool_use: { web_search_requests: 1 }, service_tier: 'priority', inference_geo: 'us',
    } as unknown as Usage);
    expect(usageOf(surcharged)).toMatchObject({ cacheWrite1hInputTokens: 5, serverToolRequests: 1, serviceTier: 'priority', inferenceGeo: 'us' });
    expect(usageOf(message('end_turn', [], { output_tokens: 2 }))).toBeNull();
  });

  it('runs through the graph: a refusal stops the run as invalid output and its tool call never executes', async () => {
    const port = {
      listDocuments: vi.fn(() => Promise.resolve({ data: { documents: [] }, retries: 0 })),
      readDocument: vi.fn(() => Promise.resolve({ data: {}, retries: 0 })),
      getPolicyPack: vi.fn(() => Promise.resolve({ data: { findings: [] }, retries: 0 })),
      propose: vi.fn(() => Promise.reject(new Error('unused'))),
      currentInputs: vi.fn(() => Promise.reject(new Error('unused'))),
    } satisfies ToolPort;
    const { client } = fakeClient([
      message('tool_use', [toolUse('list_documents', {})]),
      message('refusal', [toolUse('read_document', { documentId: 'doc-1', version: 1 })], undefined, { type: 'refusal', category: null, explanation: null }),
    ]);
    const live = provider(client);
    const binding = { expectedRevision: 1, sourceRevisionHash: 'a'.repeat(64), policyPackSha256: 'b'.repeat(64), packetHash: 'c'.repeat(64) };
    const pause = await startInvestigation(
      { provider: live, port, checkpointer: new MemorySaver(), limits: DEFAULT_LIMITS, runId: randomUUID() },
      { threadId: randomUUID(), versions: agentVersions(live), revision: 1, binding },
    );
    expect(pause.stopReason).toBe('invalid_model_output');
    expect(port.listDocuments).toHaveBeenCalledTimes(1);
    expect(port.readDocument).not.toHaveBeenCalled();
    expect(live.calls.map((call) => call.outcome)).toEqual(['tool_use', 'refusal']);
  });
});
