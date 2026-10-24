import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { agentCapability, type AgentSettings } from '@pa/agents/config';
import {
  AGENT_WORKER_PATH, AgentCompletionReport, AgentJobClaim, AttemptReservationRequest, CancelAgentRunCommand, AgentProposalSubmission, AgentReviewCommand, AgentRunFailure, AgentRunReport,
  DocumentVersion, Identifier, StartAgentRunCommand,
} from '@pa/contracts';
import type { Database, PgBoss } from '@pa/db';

import { admissionReply, grant, registerSettlementRoutes, reservation } from '../accounting/routes.js';
import type { LiveAdmission } from '../accounting/service.js';
import { actorOf } from '../auth/index.js';
import { CaseError } from '../cases/service.js';
import {
  agentDocuments, agentInputs, agentPolicy, agentReadDocument, agentRunView, AgentCapabilityDisabled, cancelAgentRun, claimAgentJob, completeAgentRun,
  failAgentRun, listAgentRunsView, liveAttemptScope, recordAwaitingReview, recordProposal, reviewAgentRun, startAgentRun,
} from './service.js';

interface AgentDeps { db: Database; boss: PgBoss; settings: AgentSettings; admission: LiveAdmission }

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new CaseError(400, 'invalid agent command');
  return parsed.data;
}

export function registerAgentRoutes(app: FastifyInstance, deps: AgentDeps & { draining: () => boolean }) {
  const capability = () => agentCapability(deps.settings, deps.admission.view());
  app.get('/api/agent/capability', (request) => { actorOf(request, 'read'); return capability(); });
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/agent-runs', async (request) => listAgentRunsView(deps.db, actorOf(request, 'read'), request.params.caseId));
  app.get<{ Params: { caseId: string; runId: string } }>('/api/cases/:caseId/agent-runs/:runId', async (request) => {
    if (!z.uuid().safeParse(request.params.runId).success) throw new CaseError(400, 'invalid run reference');
    return agentRunView(deps.db, actorOf(request, 'read'), request.params.caseId, request.params.runId);
  });
  app.register((commands, _opts, done) => {
    commands.addHook('onRequest', (_request, _reply, next) => { next(deps.draining() ? new CaseError(503, 'application is shutting down') : undefined); });
    commands.post<{ Params: { caseId: string } }>('/api/cases/:caseId/agent-runs', async (request, reply) => {
      try {
        const actor = actorOf(request, 'agent_run');
        return reply.code(202).send(await startAgentRun(deps.db, deps.boss, deps.settings, deps.admission, actor, request.params.caseId, parse(StartAgentRunCommand, request.body)));
      } catch (error) {
        if (!(error instanceof AgentCapabilityDisabled)) throw error;
        return reply.code(409).send({ error: { code: 'capability_disabled', message: error.message }, reason: error.code, capability: capability() });
      }
    });
    commands.post<{ Params: { caseId: string; runId: string } }>('/api/cases/:caseId/agent-runs/:runId/review', async (request) => {
      if (!z.uuid().safeParse(request.params.runId).success) throw new CaseError(400, 'invalid run reference');
      return reviewAgentRun(deps.db, deps.boss, actorOf(request, 'review_agent'), request.params.caseId, request.params.runId, parse(AgentReviewCommand, request.body));
    });
    commands.post<{ Params: { caseId: string; runId: string } }>('/api/cases/:caseId/agent-runs/:runId/cancel', async (request) => {
      const actor = actorOf(request, 'agent_run');
      if (!z.uuid().safeParse(request.params.runId).success) throw new CaseError(400, 'invalid run reference');
      return cancelAgentRun(deps.db, deps.admission, actor, request.params.caseId, request.params.runId, parse(CancelAgentRunCommand, request.body));
    });
    done();
  });
}

const JobParams = z.strictObject({ runId: z.uuid(), jobId: z.uuid() });

/** Only installed within the worker service-token plugin. Scope comes from the run and its active job. */
export function registerAgentInternalRoutes(internal: FastifyInstance, deps: AgentDeps) {
  const base = `${AGENT_WORKER_PATH}/:runId/jobs/:jobId`;
  type Params = { Params: { runId: string; jobId: string } };
  const ids = (params: unknown) => parse(JobParams, params);
  internal.post<Params>(`${base}/claim`, async (request) => {
    const { runId, jobId } = ids(request.params);
    return claimAgentJob(deps.db, deps.boss, deps.admission, runId, jobId, parse(AgentJobClaim, request.body).claimId);
  });
  internal.get<Params>(`${base}/documents`, async (request) => { const { runId, jobId } = ids(request.params); return agentDocuments(deps.db, deps.boss, runId, jobId); });
  internal.get<{ Params: { runId: string; jobId: string; documentId: string; version: string } }>(`${base}/documents/:documentId/versions/:version`, async (request) => {
    const { runId, jobId } = ids({ runId: request.params.runId, jobId: request.params.jobId });
    const documentId = parse(Identifier, request.params.documentId);
    const version = parse(DocumentVersion, /^[1-9][0-9]{0,8}$/.test(request.params.version) ? Number(request.params.version) : Number.NaN);
    return agentReadDocument(deps.db, deps.boss, runId, jobId, documentId, version);
  });
  internal.get<Params>(`${base}/policy`, async (request) => { const { runId, jobId } = ids(request.params); return agentPolicy(deps.db, deps.boss, runId, jobId); });
  internal.post<Params>(`${base}/proposals`, async (request) => { const { runId, jobId } = ids(request.params); return recordProposal(deps.db, deps.boss, deps.settings, runId, jobId, parse(AgentProposalSubmission, request.body)); });
  internal.get<Params>(`${base}/inputs`, async (request) => { const { runId, jobId } = ids(request.params); return agentInputs(deps.db, deps.boss, runId, jobId); });
  internal.post<{ Params: { runId: string } }>(`${AGENT_WORKER_PATH}/:runId/awaiting-review`, async (request) => recordAwaitingReview(deps.db, deps.boss, deps.admission, parse(z.uuid(), request.params.runId), parse(AgentRunReport, request.body)));
  internal.post<{ Params: { runId: string } }>(`${AGENT_WORKER_PATH}/:runId/complete`, async (request) => completeAgentRun(deps.db, deps.boss, parse(z.uuid(), request.params.runId), parse(AgentCompletionReport, request.body)));
  internal.post<{ Params: { runId: string } }>(`${AGENT_WORKER_PATH}/:runId/failure`, async (request) => failAgentRun(deps.db, deps.boss, deps.admission, parse(z.uuid(), request.params.runId), parse(AgentRunFailure, request.body)));

  // Live attempts: reserve and dispatch need the active job and current inputs; the dispatch owner is the job.
  const owner = (params: unknown) => { const { runId, jobId } = ids(params); return { runId, jobId, owner: { kind: 'worker' as const, id: jobId } }; };
  internal.post<Params>(`${base}/attempts`, (request, reply) => admissionReply(reply, async () => {
    const { runId, jobId, owner: caller } = owner(request.params);
    await liveAttemptScope(deps.db, deps.boss, deps.admission, runId, jobId);
    const result = await deps.admission.ledger().reserve(runId, parse(AttemptReservationRequest, request.body), caller);
    return reservation(result.attempt, result.replayed);
  }));
  internal.post<{ Params: { runId: string; jobId: string; attemptId: string } }>(`${base}/attempts/:attemptId/dispatch`, (request, reply) => admissionReply(reply, async () => {
    const { runId, jobId, owner: caller } = owner({ runId: request.params.runId, jobId: request.params.jobId });
    const attemptId = parse(z.uuid(), request.params.attemptId);
    await liveAttemptScope(deps.db, deps.boss, deps.admission, runId, jobId);
    const ledger = deps.admission.ledger();
    await ledger.dispatch(runId, attemptId, caller);
    return grant(ledger, attemptId);
  }));
  registerSettlementRoutes(internal, base, deps.admission, (params) => { const { runId, owner: caller } = owner({ runId: (params as Record<string, unknown>).runId, jobId: (params as Record<string, unknown>).jobId }); return { runId, owner: caller }; });
}
