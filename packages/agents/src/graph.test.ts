import { randomUUID } from 'node:crypto';

import { MemorySaver } from '@langchain/langgraph';
import { describe, expect, it, vi } from 'vitest';

import type { AgentProposalSubmission, RevisionBinding } from '@pa/contracts';

import { DEFAULT_LIMITS } from './config.js';
import { agentVersions, IncompatibleCheckpoint, resumeInvestigation, startInvestigation, type GraphDependencies } from './graph.js';
import type { AgentProvider } from './providers/types.js';
import type { ToolPort } from './tools.js';

const binding: RevisionBinding = { expectedRevision: 1, sourceRevisionHash: 'a'.repeat(64), policyPackSha256: 'b'.repeat(64), packetHash: 'c'.repeat(64) };

function scripted(outputs: unknown[], version = 'scripted:test'): AgentProvider {
  return {
    identity: { provider: 'recorded', model: 'recorded-test', label: 'scripted_fixture', recordingSha256: 'd'.repeat(64) },
    version,
    next: ({ turn }) => Promise.resolve(outputs[turn] ?? { type: 'finish' }),
  };
}

function fakePort(inputs: { revision: number; binding: RevisionBinding | null } = { revision: 1, binding }) {
  const submissions: AgentProposalSubmission[] = [];
  const port = {
    listDocuments: vi.fn(() => Promise.resolve({ data: { documents: [{ documentId: 'doc-1', version: 1 }] }, retries: 0 })),
    readDocument: vi.fn(() => Promise.resolve({ data: { payload: '{"synthetic":true,"secret":"Avery Testcase"}' }, retries: 1 })),
    getPolicyPack: vi.fn(() => Promise.resolve({ data: { findings: [] }, retries: 0 })),
    propose: vi.fn((submission: AgentProposalSubmission) => {
      submissions.push(submission);
      return Promise.resolve({ data: { proposalId: randomUUID(), status: 'valid' as const, code: null }, retries: 0 });
    }),
    currentInputs: vi.fn(() => Promise.resolve({ data: inputs, retries: 0 })),
  } satisfies ToolPort;
  return { port, submissions };
}

function deps(provider: AgentProvider, port: ToolPort, checkpointer = new MemorySaver(), overrides: Partial<GraphDependencies> = {}): GraphDependencies {
  return { provider, port, checkpointer, limits: DEFAULT_LIMITS, runId: randomUUID(), ...overrides };
}

const start = (graph: GraphDependencies, threadId = randomUUID()) =>
  startInvestigation(graph, { threadId, versions: agentVersions(graph.provider), revision: 1, binding }).then((pause) => ({ pause, threadId }));

describe('evidence graph', () => {
  it('reads, proposes, pauses for review and resumes from the saved checkpoint in a new graph instance', async () => {
    const provider = scripted([
      { type: 'call_tool', tool: 'list_documents', input: {} },
      { type: 'call_tool', tool: 'read_document', input: { documentId: 'doc-1', version: 1 } },
      { type: 'call_tool', tool: 'propose_facts', input: { candidates: [{ any: 'candidate' }, { other: 'candidate' }] } },
      { type: 'finish' },
    ]);
    const { port, submissions } = fakePort();
    const saver = new MemorySaver();
    const first = deps(provider, port, saver);
    const { pause, threadId } = await start(first);
    expect(pause.stopReason).toBe('finished');
    expect(pause.proposals).toHaveLength(2);
    expect(submissions.map((item) => item.proposalKey)).toEqual([`${first.runId}:t2:0`, `${first.runId}:t2:1`]);
    expect(pause.trace.map((step) => `${step.kind}:${step.name}:${step.outcome}`)).toEqual([
      'model:recorded:tool_requested', 'tool:list_documents:ok', 'model:recorded:tool_requested', 'tool:read_document:ok',
      'model:recorded:tool_requested', 'tool:propose_facts:ok', 'model:recorded:finish',
    ]);
    expect(pause.trace[3]!.retries).toBe(1);
    expect(JSON.stringify(pause.trace)).not.toContain('Avery Testcase');
    expect(port.currentInputs).not.toHaveBeenCalled();

    // A rebuilt graph over the same saver stands in for a restarted worker.
    const resumed = await resumeInvestigation({ ...first, port }, { threadId, versions: agentVersions(provider), resume: { reviewEventId: randomUUID() } });
    expect(resumed).toMatchObject({ inputsChanged: false, revision: 1 });
    expect(port.currentInputs).toHaveBeenCalledTimes(1);
  });

  it('reports changed inputs on resume', async () => {
    const { port } = fakePort({ revision: 2, binding: null });
    const graph = deps(scripted([]), port);
    const { threadId } = await start(graph);
    const resumed = await resumeInvestigation(graph, { threadId, versions: agentVersions(graph.provider), resume: { reviewEventId: randomUUID() } });
    expect(resumed).toMatchObject({ inputsChanged: true, revision: 2 });
  });

  it('refuses unsupported or prohibited tools and invalid inputs without any port call', async () => {
    const { port } = fakePort();
    const provider = scripted([
      { type: 'call_tool', tool: 'approve_request', input: { requestId: 'x' } },
      { type: 'call_tool', tool: 'shell', input: { command: 'cat /etc/passwd' } },
      { type: 'call_tool', tool: 'read_document', input: { documentId: '../../etc/passwd', version: 1 } },
      { type: 'call_tool', tool: 'read_document', input: { documentId: 'doc-1', version: 1, caseId: 'other-case' } },
    ]);
    const { pause } = await start(deps(provider, port));
    expect(pause.trace.filter((step) => step.kind === 'tool').map((step) => `${step.name}:${step.outcome}`)).toEqual([
      'unsupported_tool:unsupported_tool', 'unsupported_tool:unsupported_tool', 'read_document:invalid_input', 'read_document:invalid_input',
    ]);
    expect(port.readDocument).not.toHaveBeenCalled();
    expect(port.propose).not.toHaveBeenCalled();
  });

  it('stops at the model call limit and at the tool call limit', async () => {
    const loop = { next: () => Promise.resolve({ type: 'call_tool', tool: 'list_documents', input: {} }) };
    const models = await start(deps({ ...scripted([]), ...loop }, fakePort().port, new MemorySaver(), { limits: { ...DEFAULT_LIMITS, maxModelCalls: 3 } }));
    expect(models.pause.stopReason).toBe('model_call_limit');
    expect(models.pause.trace.filter((step) => step.kind === 'model')).toHaveLength(3);
    const tools = await start(deps({ ...scripted([]), ...loop }, fakePort().port, new MemorySaver(), { limits: { ...DEFAULT_LIMITS, maxToolCalls: 2 } }));
    expect(tools.pause.stopReason).toBe('tool_call_limit');
    expect(tools.pause.trace.filter((step) => step.kind === 'tool')).toHaveLength(2);
  });

  it('stops on malformed or oversized model output and on the time limit', async () => {
    expect((await start(deps(scripted([{ type: 'submit_to_payer' }]), fakePort().port))).pause.stopReason).toBe('invalid_model_output');
    const big = scripted([{ type: 'call_tool', tool: 'list_documents', input: { padding: 'x'.repeat(200) } }]);
    expect((await start(deps(big, fakePort().port, new MemorySaver(), { limits: { ...DEFAULT_LIMITS, maxOutputBytes: 100 } }))).pause.stopReason).toBe('output_limit');
    let clock = 0;
    const slow: AgentProvider = { ...scripted([]), next: () => { clock += 200_000; return Promise.resolve({ type: 'call_tool', tool: 'list_documents', input: {} }); } };
    expect((await start(deps(slow, fakePort().port, new MemorySaver(), { now: () => clock }))).pause.stopReason).toBe('time_limit');
  });

  it('rejects a checkpoint written under another prompt, graph or provider version', async () => {
    const saver = new MemorySaver();
    const graph = deps(scripted([], 'scripted:one'), fakePort().port, saver);
    const { threadId } = await start(graph);
    const changed = deps(scripted([], 'scripted:two'), fakePort().port, saver);
    await expect(resumeInvestigation(changed, { threadId, versions: agentVersions(changed.provider), resume: { reviewEventId: randomUUID() } })).rejects.toThrow(IncompatibleCheckpoint);
    await expect(resumeInvestigation(graph, { threadId: 'no-such-thread', versions: agentVersions(graph.provider), resume: { reviewEventId: randomUUID() } })).rejects.toThrow(IncompatibleCheckpoint);
  });
});
