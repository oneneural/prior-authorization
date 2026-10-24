import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { ApproveRequestCommand, CaseActionCommand, CloseRequestCommand, FixtureResponseCommand, ProposeRequestCommand, ReviewPacketCommand, WorkflowFailure, CASE_QUEUE, WORKFLOW_QUEUE, WORKFLOW_WORKER_PATH } from '@pa/contracts';
import { findCase, findCaseAssessment, findReceipt, type Database, type PgBoss } from '@pa/db';

import { actorOf } from '../auth/index.js';
import { CaseError } from '../cases/service.js';
import { approveRequest, caseAction, closeRequest, deliverRequest, fixtureResponse, proposeRequest, recordWorkflowFailure, requestScope, reviewPacket, workflowView } from './service.js';

export function registerWorkflowRoutes(app: FastifyInstance, deps: { db: Database; boss: PgBoss; draining: () => boolean }) {
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/workflow', async (request) => workflowView(deps.db, actorOf(request, 'read'), request.params.caseId));
  app.register((commands, _opts, done) => {
    commands.addHook('onRequest', (_request, _reply, next) => { next(deps.draining() ? new CaseError(503, 'application is shutting down') : undefined); });
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
      const parsed = schema.safeParse(value);
      if (!parsed.success) throw new CaseError(400, 'invalid workflow command');
      return parsed.data;
    };
    commands.post<{ Params: { caseId: string } }>('/api/cases/:caseId/requests', async (request) => proposeRequest(deps.db, actorOf(request, 'request'), request.params.caseId, parse(ProposeRequestCommand, request.body)));
    commands.post<{ Params: { caseId: string; requestId: string } }>('/api/cases/:caseId/requests/:requestId/approve', async (request) => {
      const actor = actorOf(request, 'request');
      if (!z.uuid().safeParse(request.params.requestId).success) throw new CaseError(400, 'invalid request reference');
      return approveRequest(deps.db, deps.boss, actor, request.params.caseId, request.params.requestId, parse(ApproveRequestCommand, request.body));
    });
    commands.post<{ Params: { caseId: string; requestId: string } }>('/api/cases/:caseId/requests/:requestId/close', async (request) => {
      const actor = actorOf(request, 'request');
      if (!z.uuid().safeParse(request.params.requestId).success) throw new CaseError(400, 'invalid request reference');
      return closeRequest(deps.db, actor, request.params.caseId, request.params.requestId, parse(CloseRequestCommand, request.body));
    });
    commands.post<{ Params: { caseId: string } }>('/api/cases/:caseId/reviews', async (request) => reviewPacket(deps.db, actorOf(request, 'review_packet'), request.params.caseId, parse(ReviewPacketCommand, request.body)));
    commands.post<{ Params: { caseId: string } }>('/api/cases/:caseId/fixture-events', async (request) => fixtureResponse(deps.db, deps.boss, actorOf(request, 'fixture_event'), request.params.caseId, parse(FixtureResponseCommand, request.body)));
    for (const action of ['cancel', 'recover'] as const) {
      commands.post<{ Params: { caseId: string } }>(`/api/cases/:caseId/${action}`, async (request) => caseAction(deps.db, deps.boss, actorOf(request, 'case_action'), request.params.caseId, action, parse(CaseActionCommand, request.body)));
    }
    done();
  });
}

/** Only installed within the existing service-token plugin. */
export function registerWorkflowInternalRoutes(internal: FastifyInstance, deps: { db: Database; boss: PgBoss }) {
  internal.post<{ Params: { requestId: string } }>(`${WORKFLOW_WORKER_PATH}/:requestId/deliver`, async (request) => {
    const id = z.uuid().safeParse(request.params.requestId);
    if (!id.success) throw new CaseError(400, 'invalid request reference');
    const receipt = await deps.boss.getJobById(WORKFLOW_QUEUE, id.data);
    if (receipt?.state !== 'active') throw new CaseError(409, 'request job not active');
    return deliverRequest(deps.db, id.data);
  });
  internal.post<{ Params: { jobId: string }; Body: unknown }>('/internal/worker/v1/case-jobs/:jobId/failure', async (request) => {
    const id = z.uuid().safeParse(request.params.jobId);
    const report = WorkflowFailure.safeParse(request.body);
    if (!id.success || !report.success) throw new CaseError(400, 'invalid failure report');
    const job = await findCaseAssessment(deps.db, id.data);
    const head = job === undefined ? undefined : await findCase(deps.db, job.caseId);
    if (job === undefined || head?.currentJobId !== id.data || job.revision !== report.data.revision || (await deps.boss.getJobById(CASE_QUEUE, id.data))?.state !== 'active') throw new CaseError(409, 'stale failure report');
    await recordWorkflowFailure(deps.db, job.caseId, job.revision, report.data.code, job.jobId);
    return { operatorActionRequired: true };
  });
  internal.post<{ Params: { requestId: string } }>(`${WORKFLOW_WORKER_PATH}/:requestId/failure`, async (request) => {
    const id = z.uuid().safeParse(request.params.requestId);
    const report = WorkflowFailure.safeParse(request.body);
    if (!id.success || !report.success) throw new CaseError(400, 'invalid failure report');
    if ((await deps.boss.getJobById(WORKFLOW_QUEUE, id.data))?.state !== 'active') throw new CaseError(409, 'request job not active');
    if (await findReceipt(deps.db, id.data) !== undefined) return { reconciled: true };
    const scope = await requestScope(deps.db, id.data);
    if (scope.revision !== report.data.revision) throw new CaseError(409, 'stale failure report');
    await recordWorkflowFailure(deps.db, scope.caseId, scope.revision, report.data.code, undefined, id.data);
    return { operatorActionRequired: true };
  });
}
