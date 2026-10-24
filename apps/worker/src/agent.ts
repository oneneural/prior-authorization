import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { z } from 'zod';

import {
  AdmissionRefused, AdmissionUnavailable, agentVersions, BudgetExhausted, createAnthropicProvider, createRecordedProvider, httpAdmissionPort, IncompatibleCheckpoint,
  LIVE_MODEL_DEFAULTS, LiveProviderDisabled, LiveProviderFailure, LiveProviderUnavailable, loadRecording, RecordingUnavailable, resumeInvestigation, reviewOnlyLiveProvider,
  startInvestigation, ToolPortError, unavailableLiveClient,
  type AdmissionPort, type AgentProvider, type AgentSettings, type GraphDependencies, type LiveClientFactory, type LiveProvider, type ToolPort,
} from '@pa/agents';
import { AGENT_QUEUE, AGENT_WORKER_PATH, AgentJobPayload, AgentProposalResult, AgentRunScope, RevisionBinding, type AgentJobClaim, type AgentRunFailure } from '@pa/contracts';
import type { PgBoss } from '@pa/db';

export interface AgentWorkerDeps {
  settings: AgentSettings;
  checkpointer: GraphDependencies['checkpointer'];
  /**
   * Live client construction, called once when a live investigation starts and
   * never on resume. Without it a live run fails before any admission call.
   */
  liveClientFactory?: LiveClientFactory;
  /** The API admission routes for one run and job; tests may wrap it to observe calls. */
  admissionPort?: (transport: Transport, runId: string, jobId: string) => AdmissionPort;
  /** Called with ids, counts and outcomes only, never document text or model output. */
  log?: (message: string, fields?: Record<string, unknown>) => void;
}

export interface Transport { apiOrigin: string; authorization: string }
const CurrentInputs = z.strictObject({ revision: z.int().positive(), binding: RevisionBinding.nullable() });

/** Initial attempt plus at most `maxRetries` transient retries, each counted in the trace. */
async function call(transport: Transport, path: string, maxRetries: number, init: RequestInit = {}): Promise<{ data: unknown; retries: number }> {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    let response: Response;
    try {
      response = await fetch(new URL(path, transport.apiOrigin), {
        ...init, headers: { authorization: transport.authorization, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) }, signal: AbortSignal.timeout(10_000),
      });
    } catch {
      continue;
    }
    if (response.ok) return { data: await response.json(), retries: attempt };
    if (response.status < 500 && ![408, 429].includes(response.status)) throw new ToolPortError(true, attempt, response.status);
  }
  throw new ToolPortError(false, maxRetries);
}

/** The worker's only route to case data: the API's run-and-job scoped internal routes. */
export function apiToolPort(transport: Transport, runId: string, jobId: string, maxRetries: number): ToolPort {
  const base = `${AGENT_WORKER_PATH}/${runId}/jobs/${jobId}`;
  return {
    listDocuments: () => call(transport, `${base}/documents`, maxRetries),
    readDocument: (documentId, version) => call(transport, `${base}/documents/${encodeURIComponent(documentId)}/versions/${version}`, maxRetries),
    getPolicyPack: () => call(transport, `${base}/policy`, maxRetries),
    propose: async (submission) => {
      const result = await call(transport, `${base}/proposals`, maxRetries, { method: 'POST', body: JSON.stringify(submission) });
      return { data: AgentProposalResult.parse(result.data), retries: result.retries };
    },
    currentInputs: async () => {
      const result = await call(transport, `${base}/inputs`, maxRetries);
      return { data: CurrentInputs.parse(result.data), retries: result.retries };
    },
  };
}

/** Every live attempt is admitted by the API that owns the canonical ledger; there is no local fallback. */
export function workerAdmissionPort(transport: Transport, runId: string, jobId: string): AdmissionPort {
  return httpAdmissionPort({ origin: transport.apiOrigin, authorization: transport.authorization, base: `${AGENT_WORKER_PATH}/${runId}/jobs/${jobId}` });
}

/**
 * Recorded runs replay a fixed recording. A live start constructs the client
 * (reading the key) before any admission call; a live resume uses a
 * review-only provider that constructs no client and allows no model turn.
 */
export async function selectProvider(scope: AgentRunScope, deps: AgentWorkerDeps, transport: Transport, jobId: string): Promise<AgentProvider> {
  if (scope.provider === 'anthropic') {
    if (deps.settings.graphProvider !== 'live') throw new LiveProviderDisabled('live Claude is not enabled in this deployment');
    if (scope.phase === 'resume') return reviewOnlyLiveProvider(LIVE_MODEL_DEFAULTS);
    return createAnthropicProvider(LIVE_MODEL_DEFAULTS, {
      admission: (deps.admissionPort ?? workerAdmissionPort)(transport, scope.runId, jobId),
      clientFactory: deps.liveClientFactory ?? unavailableLiveClient,
    });
  }
  if (scope.recordingId === null) throw new RecordingUnavailable('recorded run without a recording');
  return createRecordedProvider(await loadRecording(scope.recordingId));
}

export async function processAgentJob(jobId: string, payload: AgentJobPayload, transport: Transport, deps: AgentWorkerDeps): Promise<void> {
  const log = deps.log ?? (() => undefined);
  const post = (path: string, body: unknown) => call(transport, `${AGENT_WORKER_PATH}/${payload.runId}${path}`, deps.settings.limits.maxToolRetries, { method: 'POST', body: JSON.stringify(body) });
  const fail = async (code: AgentRunFailure['code']) => {
    log('agent run failed', { runId: payload.runId, jobId, code });
    await post('/failure', { jobId, code } satisfies AgentRunFailure);
  };
  // One claim identity per processing of this job; transport retries repeat it, so a lost
  // claim response is not taken for a redelivery (which stops a live run safely).
  const claim: AgentJobClaim = { claimId: randomUUID() };
  const claimed = await call(transport, `${AGENT_WORKER_PATH}/${payload.runId}/jobs/${jobId}/claim`, deps.settings.limits.maxToolRetries, { method: 'POST', body: JSON.stringify(claim) });
  const scope = AgentRunScope.parse(claimed.data);
  if (scope.runId !== payload.runId || scope.phase !== payload.phase) throw new Error('agent job scope mismatch');

  let provider: AgentProvider;
  try {
    provider = await selectProvider(scope, deps, transport, jobId);
  } catch (error) {
    if (error instanceof LiveProviderDisabled) return fail('live_provider_disabled');
    if (error instanceof LiveProviderUnavailable) return fail('live_provider_unavailable');
    if (error instanceof RecordingUnavailable) return fail('recording_unavailable');
    throw error;
  }
  const versions = agentVersions(provider);
  if (!isDeepStrictEqual(versions, scope.versions)) return fail('incompatible_checkpoint');
  const live = scope.provider === 'anthropic' && scope.phase === 'start' ? provider as LiveProvider : null;
  // A live conversation exists only in the process that sent it. A checkpoint
  // for a live start means an earlier attempt was interrupted: stop safely
  // instead of reinvoking the graph with a reconstructed conversation.
  if (live !== null && (await deps.checkpointer.getTuple({ configurable: { thread_id: scope.threadId, checkpoint_ns: '' } })) !== undefined) return fail('interrupted_before_review');
  const graph: GraphDependencies = { provider, port: apiToolPort(transport, scope.runId, jobId, deps.settings.limits.maxToolRetries), checkpointer: deps.checkpointer, limits: deps.settings.limits, runId: scope.runId };
  try {
    if (scope.phase === 'start') {
      const pause = await startInvestigation(graph, { threadId: scope.threadId, versions, revision: scope.revision, binding: scope.binding });
      // An attempt abandoned at the time limit settles its accounting before the review boundary.
      await live?.settle();
      await post('/awaiting-review', { jobId, trace: pause.trace, stopReason: pause.stopReason, modelIdentity: provider.identity });
      log('agent run awaiting review', { runId: scope.runId, jobId, steps: pause.trace.length, proposals: pause.proposals.length, stopReason: pause.stopReason });
    } else {
      if (scope.reviewEventId === null) return fail('incompatible_checkpoint');
      const result = await resumeInvestigation(graph, { threadId: scope.threadId, versions, resume: { reviewEventId: scope.reviewEventId } });
      await post('/complete', { jobId, trace: result.trace, inputsChanged: result.inputsChanged });
      log('agent run completed', { runId: scope.runId, jobId, inputsChanged: result.inputsChanged });
    }
  } catch (error) {
    await live?.settle();
    if (error instanceof IncompatibleCheckpoint) return fail('incompatible_checkpoint');
    if (error instanceof BudgetExhausted) return fail('budget_refused');
    // Any other refusal or doubt means no further grant: the run stops with its spend held.
    if (error instanceof AdmissionRefused || error instanceof AdmissionUnavailable) return fail('admission_unavailable');
    if (error instanceof LiveProviderFailure) return fail('live_provider_unavailable');
    if (error instanceof LiveProviderDisabled) return fail('live_provider_disabled');
    log('agent run error', { runId: scope.runId, jobId, error: error instanceof Error ? error.name : 'unknown' });
    return fail('agent_error');
  }
}

/** A run waiting for a person holds no job: the start job completes at the review interrupt. */
export async function startAgentJobs(boss: PgBoss, transport: Transport, concurrency: number, active: Set<string>, started: (jobId: string) => Promise<void>, deps: AgentWorkerDeps) {
  await boss.work(AGENT_QUEUE, { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1, perJobResults: true }, async ([job]) => {
    if (job === undefined) return [];
    const payload = AgentJobPayload.safeParse(job.data);
    if (!payload.success) return [{ id: job.id, status: 'deadletter' as const, output: { error: 'malformed_payload' } }];
    active.add(job.id);
    try {
      await started(job.id);
      await processAgentJob(job.id, payload.data, transport, deps);
      return [{ id: job.id, status: 'completed' as const }];
    } catch (error) {
      (deps.log ?? (() => undefined))('agent job not processed', { jobId: job.id, error: error instanceof ToolPortError ? error.message : 'agent_job_error' });
      return [{ id: job.id, status: 'deadletter' as const, output: { error: 'operator_action_required' } }];
    } finally {
      active.delete(job.id);
    }
  });
}
