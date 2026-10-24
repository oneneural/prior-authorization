import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

import Anthropic from '@anthropic-ai/sdk';

import type { AttemptState, ProviderUsage } from '@pa/contracts';

import { AdmissionRefused, AdmissionUnavailable, type AdmissionPort } from '../admission/port.js';
import { EVIDENCE_PROMPT } from '../prompt.js';
import { TOOL_NAMES } from '../tools.js';
import { LIVE_MODEL_DEFAULTS, liveProviderVersion, type LiveModelSettings } from '../versions.js';
import { LIVE_TASK, LIVE_TOOLS } from './live-tools.js';
import type { AgentProvider, Observation, ProviderContext } from './types.js';

/**
 * Live Claude boundary. Every Messages request needs a durable reservation and
 * a single-use dispatch grant from the API's accounting ledger, obtained
 * through an `AdmissionPort` before any network I/O. The provider itself holds
 * no budget: caps, days and totals are the API's.
 */
export class LiveProviderDisabled extends Error {
  readonly code = 'live_provider_disabled';
  override name = 'LiveProviderDisabled';
}
/** The key file or provider cannot be used; refused before any request. */
export class LiveProviderUnavailable extends Error {
  readonly code = 'live_provider_unavailable';
  override name = 'LiveProviderUnavailable';
}
/** The provider request failed after its grant; the reservation stays held. */
export class LiveProviderFailure extends Error {
  readonly code = 'live_provider_unavailable';
  override name = 'LiveProviderFailure';
}
export class BudgetExhausted extends Error {
  readonly code = 'budget_exhausted';
  override name = 'BudgetExhausted';
}
/** The graph's observations no longer match the conversation this provider sent. */
export class LiveTranscriptMismatch extends Error {
  override name = 'LiveTranscriptMismatch';
}

/** Dated list prices in USD per million tokens, for reports. Accounting uses `OPUS_5_5_TARIFF`. */
export interface LivePrice { inputPerMTok: number; outputPerMTok: number; cacheWritePerMTok: number; cacheReadPerMTok: number }

/**
 * Claude Opus 5.5 standard prices from https://platform.claude.com/docs/en/about-claude/pricing,
 * read on 2026-10-21: base input $4, 5-minute cache write $5 (1.25x), cache hit $0.20, output $20.
 */
export const OPUS_5_5_PRICE: LivePrice = { inputPerMTok: 4, outputPerMTok: 20, cacheWritePerMTok: 5, cacheReadPerMTok: 0.2 };
export const OPUS_5_5_PRICE_SNAPSHOT = { model: 'claude-opus-5-5', source: 'https://platform.claude.com/docs/en/about-claude/pricing', readOn: '2026-10-21', usdPerMTok: OPUS_5_5_PRICE } as const;

export type LiveEffort = LiveModelSettings['effort'];
export type LiveSettings = LiveModelSettings;
export { LIVE_MODEL_DEFAULTS, liveProviderVersion };

/** The one Messages API operation the provider needs; tests pass a fake. */
export interface LiveModelClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming, signal: AbortSignal): Promise<Anthropic.Message>;
}
export type LiveClientFactory = () => LiveModelClient;

/** Factory for deployments without live mode: constructing a live client always fails. */
export const unavailableLiveClient: LiveClientFactory = () => { throw new LiveProviderDisabled('no live model client is enabled in this deployment'); };

/**
 * The official SDK client, keyed only from `apiKeyFile`, and the only place
 * the SDK sends a Messages request. The key is read when the factory runs and
 * is never logged or returned. Explicit base URL, no auth token and retries
 * disabled at both client and request level keep environment settings from
 * redirecting the call or multiplying billed attempts.
 */
export function sdkLiveClient(apiKeyFile: string): LiveClientFactory {
  return () => {
    let apiKey: string;
    try {
      apiKey = readFileSync(apiKeyFile, 'utf8').trim();
    } catch {
      throw new LiveProviderUnavailable('the API key file could not be read');
    }
    if (apiKey === '') throw new LiveProviderUnavailable('the API key file is empty');
    const client = new Anthropic({ apiKey, authToken: null, baseURL: 'https://api.anthropic.com', maxRetries: 0, timeout: 170_000, logLevel: 'off' });
    return { create: (params, signal) => client.messages.create(params, { signal, maxRetries: 0 }) };
  };
}

/** Complete reported usage, or null when any required billed count is missing. */
export function usageOf(message: Anthropic.Message): ProviderUsage | null {
  const usage = message.usage as Partial<Anthropic.Usage> | undefined;
  if (usage === undefined || typeof usage.input_tokens !== 'number' || typeof usage.output_tokens !== 'number') return null;
  const count = (value: unknown) => (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null);
  const serverTools = Object.values((usage.server_tool_use ?? {}) as Record<string, unknown>).reduce<number>((sum, value) => sum + (count(value) ?? 0), 0);
  const fields = {
    inputTokens: count(usage.input_tokens), outputTokens: count(usage.output_tokens),
    cacheCreationInputTokens: count(usage.cache_creation_input_tokens ?? 0), cacheReadInputTokens: count(usage.cache_read_input_tokens ?? 0),
    cacheWrite1hInputTokens: count(usage.cache_creation?.ephemeral_1h_input_tokens ?? 0),
  };
  if (Object.values(fields).some((value) => value === null)) return null;
  return {
    ...(fields as Record<keyof typeof fields, number>), serverToolRequests: serverTools,
    serviceTier: typeof usage.service_tier === 'string' ? usage.service_tier : null,
    inferenceGeo: typeof usage.inference_geo === 'string' ? usage.inference_geo : null,
  };
}

const providerId = (value: unknown) => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,200}$/.test(value) ? value : null);

/**
 * Explicit per-call outcomes. Refusal, truncation and unexpected stops return
 * a `provider_failure` turn that the graph rejects as invalid output, so no
 * tool from that response ever runs.
 */
export type LiveCallOutcome = 'tool_use' | 'finish' | 'refusal' | 'max_tokens' | 'unexpected_stop' | 'api_error' | 'budget_refused' | 'admission_refused' | 'admission_unavailable';
export interface LiveCall {
  turn: number;
  outcome: LiveCallOutcome;
  attemptId: string | null;
  stopReason: string | null;
  /** `stop_details.category` for a refusal; the explanation text is not kept. */
  refusalCategory: string | null;
  /** Allowlisted tool the model chose, or `unsupported_tool`. */
  tool: string | null;
  usage: ProviderUsage | null;
  /** Units held before the request; 0 when admission refused. */
  reservedUnits: number;
  /** The API's reconciled cost in units; null keeps the reservation committed. */
  actualUnits: number | null;
  /** Ledger state after the call. */
  attemptState: AttemptState | null;
  /** True when the provider request was sent. */
  requested: boolean;
  latencyMs: number;
  /** SDK error class and HTTP status for `api_error`; never a message body. */
  error: { type: string; status: number | null } | null;
}

export type LiveProvider = AgentProvider & {
  readonly calls: readonly LiveCall[];
  /** Resolves once the accounting for an abandoned in-flight call has been reported. */
  settle(): Promise<void>;
};

function toolResultText(observation: Observation): string {
  return JSON.stringify({ outcome: observation.outcome, result: observation.result ?? null });
}

/**
 * One provider per investigation and process. It keeps the exact conversation
 * it sent, including thinking blocks unchanged, and appends one tool result per
 * graph observation. Another process never reconstructs this conversation: an
 * interrupted live run stops safely instead (ADR 0001).
 */
export function createAnthropicProvider(settings: LiveSettings, deps: { admission: AdmissionPort; clientFactory: LiveClientFactory }): LiveProvider {
  // Reads the key now, before any reservation, so a missing key makes no request.
  const client = deps.clientFactory();
  const calls: LiveCall[] = [];
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: LIVE_TASK }];
  let pendingToolUseId: string | null = null;
  let consumed = 0;
  let inflight: Promise<unknown> = Promise.resolve();

  function appendObservations(observations: readonly Observation[]) {
    if (pendingToolUseId !== null) {
      const observation = observations[consumed];
      if (observation === undefined || observations.length !== consumed + 1) throw new LiveTranscriptMismatch('expected exactly one new tool observation');
      messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: pendingToolUseId, content: toolResultText(observation), is_error: observation.outcome !== 'ok' }] });
      consumed += 1;
      pendingToolUseId = null;
    } else if (observations.length !== consumed) {
      throw new LiveTranscriptMismatch('observations differ from the conversation sent');
    }
  }

  async function next(context: ProviderContext): Promise<unknown> {
    appendObservations(context.observations);
    // Stable tools and system first, each cached for five minutes; the growing
    // conversation is cached automatically at its last block.
    const params: Anthropic.MessageCreateParamsNonStreaming = {
      model: settings.model,
      max_tokens: settings.maxOutputTokens,
      output_config: { effort: settings.effort },
      system: [{ type: 'text', text: EVIDENCE_PROMPT, cache_control: { type: 'ephemeral' } }],
      tools: LIVE_TOOLS,
      tool_choice: { type: 'auto', disable_parallel_tool_use: true },
      cache_control: { type: 'ephemeral' },
      messages: [...messages],
    };
    const base: Omit<LiveCall, 'turn' | 'outcome'> = {
      attemptId: null, stopReason: null, refusalCategory: null, tool: null, usage: null, reservedUnits: 0, actualUnits: null, attemptState: null, requested: false, latencyMs: 0, error: null,
    };
    const record = (call: Omit<LiveCall, 'turn'>) => { calls.push({ turn: context.turn, ...call }); };
    const requestHash = createHash('sha256').update(JSON.stringify(params)).digest('hex');

    // 1. Durable reservation. An identical retry after a lost acknowledgement returns the same attempt.
    let reservation;
    try {
      reservation = await deps.admission.reserve({ turn: context.turn, ordinal: 0, requestHash, model: settings.model, maxOutputTokens: settings.maxOutputTokens });
    } catch (error) {
      if (error instanceof AdmissionRefused) {
        record({ ...base, outcome: error.code === 'budget_exhausted' ? 'budget_refused' : 'admission_refused' });
        throw error.code === 'budget_exhausted' ? new BudgetExhausted('another model call would exceed the run, daily or total budget') : error;
      }
      record({ ...base, outcome: 'admission_unavailable' });
      throw error;
    }
    const held = { ...base, attemptId: reservation.attemptId, reservedUnits: reservation.reservedUnits, attemptState: reservation.state };

    // 2. The single-use dispatch grant. Without it nothing is sent.
    try {
      await deps.admission.dispatch(reservation.attemptId);
    } catch (error) {
      if (error instanceof AdmissionRefused) {
        // No grant was issued, so the reservation can be released.
        const released = await deps.admission.release(reservation.attemptId).catch(() => null);
        record({ ...held, outcome: error.code === 'budget_exhausted' ? 'budget_refused' : 'admission_refused', attemptState: released?.state ?? 'reserved' });
        throw error;
      }
      // The grant may exist without its acknowledgement, so nothing is ever sent.
      // The ledger releases the attempt only if it is still `reserved` (no grant
      // was recorded); a refused or uncertain release holds it in full instead.
      const released = await deps.admission.release(reservation.attemptId).catch(() => null);
      const settled = released?.state === 'released' ? released : await deps.admission.unknown(reservation.attemptId).catch(() => null);
      record({ ...held, outcome: 'admission_unavailable', attemptState: settled?.state ?? null });
      throw error instanceof AdmissionUnavailable ? error : new AdmissionUnavailable('dispatch outcome unknown');
    }

    // 3. Exactly one provider request.
    const started = performance.now();
    let message: Anthropic.Message;
    try {
      message = await client.create(params, context.signal);
    } catch (error) {
      const settled = await deps.admission.unknown(reservation.attemptId).catch(() => null);
      const status = error instanceof Anthropic.APIError && typeof error.status === 'number' ? error.status : null;
      record({ ...held, outcome: 'api_error', requested: true, attemptState: settled?.state ?? 'dispatching', latencyMs: performance.now() - started, error: { type: error instanceof Error ? error.constructor.name : 'unknown', status } });
      throw new LiveProviderFailure('the provider request failed; its reservation is held');
    }
    const latencyMs = performance.now() - started;

    // 4. Usage and response identity are durable before any tool runs.
    const usage = usageOf(message);
    const settlement = usage === null
      ? await deps.admission.unknown(reservation.attemptId)
      : await deps.admission.reconcile(reservation.attemptId, {
        usage, providerRequestId: providerId((message as { _request_id?: unknown })._request_id), providerMessageId: providerId(message.id), model: typeof message.model === 'string' ? message.model : null,
      });
    const done = { ...held, requested: true, stopReason: message.stop_reason, usage, actualUnits: settlement.actualUnits, attemptState: settlement.state, latencyMs };
    if (message.stop_reason === 'refusal') {
      record({ ...done, outcome: 'refusal', refusalCategory: message.stop_details?.category ?? null });
      return { type: 'provider_failure', reason: 'refusal' };
    }
    if (message.stop_reason === 'max_tokens') {
      record({ ...done, outcome: 'max_tokens' });
      return { type: 'provider_failure', reason: 'max_tokens' };
    }
    if (message.stop_reason !== 'tool_use' && message.stop_reason !== 'end_turn') {
      record({ ...done, outcome: 'unexpected_stop' });
      return { type: 'provider_failure', reason: 'unexpected_stop' };
    }
    const toolUses = message.content.filter((block): block is Anthropic.ToolUseBlock => block.type === 'tool_use');
    if (toolUses.length > 1) {
      // Parallel tool use is disabled; a multiple-tool shape is refused, not partly executed.
      record({ ...done, outcome: 'unexpected_stop' });
      return { type: 'provider_failure', reason: 'multiple_tools' };
    }
    messages.push({ role: 'assistant', content: message.content });
    const toolUse = toolUses[0];
    if (toolUse === undefined) {
      record({ ...done, outcome: 'finish' });
      return { type: 'finish' };
    }
    pendingToolUseId = toolUse.id;
    record({ ...done, outcome: 'tool_use', tool: (TOOL_NAMES as string[]).includes(toolUse.name) ? toolUse.name : 'unsupported_tool' });
    // Input stays untrusted: the graph validates it against the tool allowlist.
    return { type: 'call_tool', tool: toolUse.name, input: toolUse.input };
  }

  return {
    identity: { provider: 'anthropic', model: settings.model, label: 'live_claude', recordingSha256: null },
    version: liveProviderVersion(settings),
    calls,
    next(context) {
      const result = next(context);
      inflight = result.catch(() => undefined);
      return result;
    },
    async settle() { await inflight; },
  };
}

/**
 * A provider for review-only resumption of a live run: it has the live version
 * so the checkpoint matches, constructs no client, reads no key and refuses
 * any model turn.
 */
export function reviewOnlyLiveProvider(settings: LiveSettings): AgentProvider {
  return {
    identity: { provider: 'anthropic', model: settings.model, label: 'live_claude', recordingSha256: null },
    version: liveProviderVersion(settings),
    next: () => Promise.reject(new LiveProviderDisabled('no model turn is permitted while resuming a reviewed live run')),
  };
}
