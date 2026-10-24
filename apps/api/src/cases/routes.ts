import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { CASE_NOTICE, CASE_WORKER_PATH, AssessCaseRequest, CaseResultReport, CaseJobScope, DocumentExact, IntakeCaseV2, JsonPointer } from '@pa/contracts';
import { lastCaseEventTimes, listCases, readCaseSnapshot, type Database, type PgBoss } from '@pa/db';

import { sourceHash } from '@pa/connectors';

import { actorOf } from '../auth/index.js';
import { sendError } from '../errors.js';
import { assessCase, authorizedCase, CaseError, currentAssessment, isWithheld, jobScope, recordCaseResult, sourceAt } from './service.js';

export function registerCaseRoutes(app: FastifyInstance, deps: { db: Database; boss: PgBoss; draining: () => boolean }) {
  app.get('/api/cases', async (request) => {
    const actor = actorOf(request, 'read');
    const rows = await listCases(deps.db, actor.teamId);
    const updated = await lastCaseEventTimes(deps.db, rows.map((row) => row.caseId));
    const cases = [];
    for (const row of rows) {
      const snapshot = await readCaseSnapshot(deps.db, row.caseId, row.revision);
      const record = snapshot === undefined ? null : IntakeCaseV2.parse(JSON.parse(snapshot.caseText));
      const outcome = (await currentAssessment(deps.db, row.caseId, row.revision))?.outcome;
      const findings = outcome?.outcome === 'assessed' ? outcome.result.findings : null;
      cases.push({
        ...row, itemCode: record?.itemCode ?? null, requestKind: record?.requestKind ?? null,
        outstandingIssues: findings === null ? null : findings.filter((finding) => !['pass', 'not_applicable'].includes(finding.status)).length,
        clinicalQuestions: findings === null ? null : findings.filter((finding) => finding.status === 'manual_review').length,
        lastEvidenceUpdate: updated.get(row.caseId)?.toISOString() ?? null,
      });
    }
    return { notice: CASE_NOTICE, mode: 'rules_only', cases };
  });
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId', async (request) => {
    const head = await authorizedCase(deps.db, request.params.caseId, actorOf(request, 'read'));
    const snapshot = await readCaseSnapshot(deps.db, head.caseId, head.revision);
    return { notice: CASE_NOTICE, mode: 'rules_only', ...head, record: IntakeCaseV2.parse(JSON.parse(snapshot!.caseText)), assessment: (await currentAssessment(deps.db, head.caseId, head.revision))?.outcome ?? null };
  });
  app.post<{ Params: { caseId: string } }>('/api/cases/:caseId/assess', async (request, reply) => {
    if (deps.draining()) return sendError(reply, 503, 'shutting_down', 'The application is shutting down');
    const body = AssessCaseRequest.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_request', 'Expected case revision is required');
    const jobId = await assessCase(deps.db, deps.boss, request.params.caseId, body.data.expectedRevision, actorOf(request, 'assess'));
    return reply.code(202).send({ jobId, notice: CASE_NOTICE });
  });
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/documents', async (request) => {
    const head = await authorizedCase(deps.db, request.params.caseId, actorOf(request, 'read'));
    const snapshot = await readCaseSnapshot(deps.db, head.caseId, head.revision);
    return { notice: CASE_NOTICE, documents: snapshot!.documents.map((doc) => DocumentExact.parse(JSON.parse(doc.metadataText))) };
  });
  app.get<{ Params: { caseId: string; documentId: string; version: string }; Querystring: { locator?: string } }>('/api/cases/:caseId/documents/:documentId/versions/:version', async (request) => {
    const head = await authorizedCase(deps.db, request.params.caseId, actorOf(request, 'read'));
    const { documentId, version } = request.params;
    if (!/^[1-9][0-9]*$/.test(version) || !Number.isSafeInteger(Number(version))) throw new CaseError(400, 'invalid version');
    const query = z.strictObject({ locator: JsonPointer.optional() }).safeParse(request.query);
    if (!query.success) throw new CaseError(400, 'invalid source locator');
    const snapshot = await readCaseSnapshot(deps.db, head.caseId, head.revision);
    const assessment = await currentAssessment(deps.db, head.caseId, head.revision);
    if (assessment?.outcome?.outcome !== 'assessed') throw new CaseError(409, 'source classification pending');
    if (isWithheld(assessment.outcome, documentId, Number(version))) throw new CaseError(404, 'case resource unavailable');
    return { notice: CASE_NOTICE, ...sourceAt(snapshot!, documentId, Number(version), query.data.locator) };
  });
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/policy', async (request) => {
    const head = await authorizedCase(deps.db, request.params.caseId, actorOf(request, 'read'));
    const snapshot = await readCaseSnapshot(deps.db, head.caseId, head.revision);
    return { notice: CASE_NOTICE, policyText: snapshot!.policyText, policyPackSha256: sourceHash(snapshot!.policyText) };
  });
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/packet', async (request) => {
    const head = await authorizedCase(deps.db, request.params.caseId, actorOf(request, 'read'));
    const assessment = await currentAssessment(deps.db, head.caseId, head.revision);
    if (assessment?.packet === null || assessment?.packet === undefined || ['assessing', 'recoverable_error', 'cancelled'].includes(head.state)) throw new CaseError(409, 'current packet unavailable');
    return assessment.packet;
  });
}

/** Registered inside the worker-token protected plugin, never under the public API. */
export function registerCaseInternalRoutes(internal: FastifyInstance, deps: { db: Database; boss: PgBoss }) {
  internal.get<{ Params: { jobId: string } }>(`${CASE_WORKER_PATH}/:jobId`, async (request) => {
    if (!CaseJobScope.shape.jobId.safeParse(request.params.jobId).success) throw new CaseError(400, 'invalid job reference');
    return jobScope(deps.db, deps.boss, request.params.jobId);
  });
  internal.post<{ Params: { jobId: string } }>(`${CASE_WORKER_PATH}/:jobId/result`, { bodyLimit: 2 * 1024 * 1024 }, async (request, reply) => {
    if (!CaseJobScope.shape.jobId.safeParse(request.params.jobId).success) throw new CaseError(400, 'invalid job reference');
    const body = CaseResultReport.safeParse(request.body);
    if (!body.success) return sendError(reply, 400, 'invalid_request', 'Invalid case result');
    return recordCaseResult(deps.db, deps.boss, request.params.jobId, body.data);
  });
}
