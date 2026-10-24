import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { Annotation, Command, END, interrupt, isInterrupted, START, StateGraph, type BaseCheckpointSaver } from '@langchain/langgraph';
import { z } from 'zod';

import type { AgentProposalResult, AgentStopReason, AgentTraceStep, AgentVersions, RevisionBinding } from '@pa/contracts';

import type { AgentLimits } from './config.js';
import { ProviderTurn, type AgentProvider, type Observation } from './providers/types.js';
import { executeTool, TOOL_NAMES, type ToolPort } from './tools.js';
import { runVersions } from './versions.js';

export const agentVersions = (provider: AgentProvider): AgentVersions => runVersions(provider.version);

export class IncompatibleCheckpoint extends Error {
  override name = 'IncompatibleCheckpoint';
}

const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value ?? null)).digest('hex');
const append = <T>(left: T[], right: T[]) => left.concat(right);
const last = <T>(fallback: () => T) => Annotation<T>({ reducer: (_left, right) => right, default: fallback });

const State = Annotation.Root({
  versions: Annotation<AgentVersions>,
  revision: Annotation<number>,
  binding: Annotation<RevisionBinding>,
  startedAt: Annotation<number>,
  modelCalls: last(() => 0),
  toolCalls: last(() => 0),
  pending: last<{ tool: string; input: Record<string, unknown> } | null>(() => null),
  stopReason: last<AgentStopReason | null>(() => null),
  reviewResume: last<ReviewResume | null>(() => null),
  finalInputs: last<{ changed: boolean; revision: number } | null>(() => null),
  observations: Annotation<Observation[]>({ reducer: append, default: () => [] }),
  trace: Annotation<AgentTraceStep[]>({ reducer: append, default: () => [] }),
  proposals: Annotation<AgentProposalResult[]>({ reducer: append, default: () => [] }),
});
type GraphState = typeof State.State;

/** The resume value names only the persisted review event; decisions stay in the API. */
export const ReviewResume = z.strictObject({ reviewEventId: z.uuid() });
export type ReviewResume = z.infer<typeof ReviewResume>;

export interface GraphDependencies {
  provider: AgentProvider;
  port: ToolPort;
  checkpointer: BaseCheckpointSaver;
  limits: AgentLimits;
  runId: string;
  now?: () => number;
}

class Timeout extends Error {}
async function withDeadline<T>(ms: number, run: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Timeout()); }, ms); });
  try {
    return await Promise.race([run(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * agent -> tools -> agent ... -> review (interrupt) -> finalize. Work before the
 * interrupt is reads and idempotent, keyed proposals only; all authority stays
 * with the API. The review node reruns on resume and has no side effects.
 */
export function buildEvidenceGraph(deps: GraphDependencies) {
  const now = deps.now ?? Date.now;
  const { limits, provider } = deps;

  async function agent(state: GraphState): Promise<Partial<GraphState>> {
    if (state.modelCalls >= limits.maxModelCalls) return { stopReason: 'model_call_limit' };
    const remaining = state.startedAt + limits.maxRunSeconds * 1000 - now();
    if (remaining <= 0) return { stopReason: 'time_limit' };
    const started = now();
    let raw: unknown;
    try {
      raw = await withDeadline(remaining, (signal) => provider.next({ turn: state.modelCalls, observations: state.observations, signal }));
    } catch (error) {
      if (error instanceof Timeout) return { stopReason: 'time_limit' };
      throw error;
    }
    const turn = ProviderTurn.safeParse(raw);
    const oversized = Buffer.byteLength(JSON.stringify(raw ?? null)) > limits.maxOutputBytes;
    const outcome = oversized ? 'output_limit' : !turn.success ? 'invalid_output' : turn.data.type === 'finish' ? 'finish' : 'tool_requested';
    const step: AgentTraceStep = {
      step: state.trace.length, kind: 'model', name: provider.identity.provider, outcome,
      inputHash: sha256(state.observations), outputHash: sha256(raw), elapsedMs: Math.max(0, now() - started), retries: 0,
    };
    const update = { modelCalls: state.modelCalls + 1, trace: [step] };
    if (oversized) return { ...update, stopReason: 'output_limit' };
    if (!turn.success) return { ...update, stopReason: 'invalid_model_output' };
    if (turn.data.type === 'finish') return { ...update, stopReason: 'finished' };
    return { ...update, pending: { tool: turn.data.tool, input: turn.data.input } };
  }

  async function tools(state: GraphState): Promise<Partial<GraphState>> {
    if (state.toolCalls >= limits.maxToolCalls) return { stopReason: 'tool_call_limit', pending: null };
    const { tool, input } = state.pending!;
    const started = now();
    const result = await executeTool(tool, input, { port: deps.port, proposalKey: `${deps.runId}:t${state.toolCalls}`, maxOutputBytes: limits.maxOutputBytes });
    // A model-chosen name is never written to the trace unless it is an allowlisted tool.
    const name = (TOOL_NAMES as string[]).includes(tool) ? tool : 'unsupported_tool';
    const step: AgentTraceStep = {
      step: state.trace.length, kind: 'tool', name, outcome: result.outcome,
      inputHash: sha256(input), outputHash: sha256(result.observation), elapsedMs: Math.max(0, now() - started), retries: result.retries,
    };
    return {
      toolCalls: state.toolCalls + 1, pending: null, trace: [step], proposals: result.proposals,
      observations: [{ tool: name, outcome: result.outcome, result: result.observation }],
    };
  }

  function review(state: GraphState): Partial<GraphState> {
    const resume: unknown = interrupt({ kind: 'human_review', proposalIds: state.proposals.map((item) => item.proposalId), stopReason: state.stopReason });
    return { reviewResume: ReviewResume.parse(resume) };
  }

  // Resume rereads the current case inputs; the API independently rechecks them.
  async function finalize(state: GraphState): Promise<Partial<GraphState>> {
    const current = (await deps.port.currentInputs()).data;
    const changed = current.binding === null || current.revision !== state.revision || !isDeepStrictEqual(current.binding, state.binding);
    return { finalInputs: { changed, revision: current.revision } };
  }

  return new StateGraph(State)
    .addNode('agent', agent)
    .addNode('tools', tools)
    .addNode('review', review)
    .addNode('finalize', finalize)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', (state) => (state.stopReason === null ? 'tools' : 'review'), ['tools', 'review'])
    .addConditionalEdges('tools', (state) => (state.stopReason === null ? 'agent' : 'review'), ['agent', 'review'])
    .addEdge('review', 'finalize')
    .addEdge('finalize', END)
    .compile({ checkpointer: deps.checkpointer });
}

export interface InvestigationPause {
  stopReason: AgentStopReason;
  trace: AgentTraceStep[];
  proposals: AgentProposalResult[];
}
export interface InvestigationResult {
  inputsChanged: boolean;
  revision: number;
  trace: AgentTraceStep[];
}

const runConfig = (threadId: string) => ({ configurable: { thread_id: threadId }, recursionLimit: 64, durability: 'sync' as const });

function assertCompatible(stored: AgentVersions | undefined, expected: AgentVersions) {
  if (stored === undefined || !isDeepStrictEqual(stored, expected)) throw new IncompatibleCheckpoint('checkpoint graph, schema, prompt or provider version differs');
}

/** Runs to the human-review interrupt. A thread with a compatible checkpoint continues from it. */
export async function startInvestigation(deps: GraphDependencies, input: { threadId: string; versions: AgentVersions; revision: number; binding: RevisionBinding }): Promise<InvestigationPause> {
  const graph = buildEvidenceGraph(deps);
  const config = runConfig(input.threadId);
  const existing = await graph.getState(config);
  const stored = (existing.values as Partial<GraphState>).versions;
  if (stored !== undefined) assertCompatible(stored, input.versions);
  const values = stored === undefined
    ? await graph.invoke({ versions: input.versions, revision: input.revision, binding: input.binding, startedAt: (deps.now ?? Date.now)() }, config)
    : await graph.invoke(null, config);
  if (!isInterrupted(values)) throw new Error('investigation ended without the human review interrupt');
  const state = (await graph.getState(config)).values as GraphState;
  return { stopReason: state.stopReason!, trace: state.trace, proposals: state.proposals };
}

/** Resumes only a compatible checkpoint that is waiting for review. */
export async function resumeInvestigation(deps: GraphDependencies, input: { threadId: string; versions: AgentVersions; resume: ReviewResume }): Promise<InvestigationResult> {
  const graph = buildEvidenceGraph(deps);
  const config = runConfig(input.threadId);
  const snapshot = await graph.getState(config);
  assertCompatible((snapshot.values as Partial<GraphState>).versions, input.versions);
  if (!snapshot.next.includes('review')) throw new IncompatibleCheckpoint('checkpoint is not waiting for review');
  const values = await graph.invoke(new Command({ resume: input.resume }), config);
  return { inputsChanged: values.finalInputs!.changed, revision: values.finalInputs!.revision, trace: values.trace };
}
