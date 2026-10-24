import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { loadFixture } from '@pa/connectors';
import { findCase, readCaseSnapshot } from '@pa/db';

import { CASE_QUEUE, CASE_WORKER_PATH, type CasePacket, DocumentExact, WORKFLOW_QUEUE, WORKFLOW_WORKER_PATH, type CaseSnapshot, type RevisionBinding } from '@pa/contracts';

import { startWorkflowJobs } from '../../worker/src/workflow.js';
import { processCaseJob } from '../../worker/src/cases.js';
import { buildApi } from '../src/app.js';
import { persistCase } from '../src/cases/service.js';
import { deliverRequest } from '../src/workflow/service.js';
import { adminQuery, startApiHarness, testApiConfig, TEST_TOKEN, type ApiHarness } from './support.js';

let harness: ApiHarness;
let origin: string;
let dropAcknowledgement = false;
const authorization = `Bearer ${TEST_TOKEN}`;
const headers = { authorization };

beforeAll(async () => {
  harness = await startApiHarness();
  await harness.app.close();
  harness.app = buildApi({ config: testApiConfig(harness.database.urls.api), db: harness.handle.db, boss: harness.apiBoss, logger: false });
  harness.app.addHook('onSend', (request, reply, payload, next) => {
    if (dropAcknowledgement && reply.statusCode === 200 && request.url.endsWith('/deliver')) {
      dropAcknowledgement = false;
      // The adapter transaction already committed. Only its HTTP acknowledgement is lost.
      reply.raw.destroy();
    }
    next(null, payload);
  });
  origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => { await harness?.close(); });

async function post(caseId: string, path: string, payload: unknown, status = 200) {
  const response = await harness.inject({ method: 'POST', url: `/api/cases/${caseId}/${path}`, headers: { 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  expect(response.statusCode, response.body).toBe(status);
  return response.json<Record<string, unknown>>();
}
async function view(caseId: string) {
  const response = await harness.inject(`/api/cases/${caseId}/workflow`);
  expect(response.statusCode).toBe(200);
  return response.json<{
    binding: RevisionBinding; head: { state: string; revision: number };
    requests: { requestId: string; state: string; contentHash: string; approvedBy: string | null; approvedPayload: unknown }[];
    receipts: { receiptId: string; requestId: string }[];
    decisions: unknown[]; packets: { superseded: boolean; packet: CasePacket }[];
    responses: { disposition: string }[];
  }>();
}
async function assess() {
  const jobs = await harness.workerBoss.fetch(CASE_QUEUE);
  expect(jobs).toHaveLength(1);
  const job = jobs[0]!;
  await processCaseJob(job.id, origin, authorization);
  await harness.workerBoss.complete(CASE_QUEUE, job.id);
  return job.id;
}
async function missingCase(caseId: string, fixture: 'F01' | 'F05b' = 'F01') {
  const snapshot = await loadFixture(fixture);
  snapshot.caseText = JSON.stringify({ ...JSON.parse(snapshot.caseText), caseId });
  snapshot.documents = snapshot.documents.filter((doc) => !['order', 'order_receipt'].includes(DocumentExact.parse(JSON.parse(doc.metadataText)).kind));
  await persistCase(harness.handle.db, harness.apiBoss, snapshot);
  await assess();
  return snapshot;
}
async function draftAndApprove(caseId: string) {
  const current = await view(caseId);
  const packet = current.packets.find((item) => !item.superseded)!.packet;
  const finding = packet.findings.find((item) => item.ruleId === 'R03')!;
  const draft = { ...current.binding, findingId: finding.findingId, templateId: 'existing_order', recipientRole: 'practitioner_records', idempotencyKey: randomUUID(), eventId: randomUUID() };
  const created = await post(caseId, 'requests', draft);
  const request = created.request as { requestId: string; contentHash: string; state: string };
  expect(request.state).toBe('draft');
  expect(await post(caseId, 'requests', draft)).toEqual(created);
  expect(await post(caseId, 'requests', { ...draft, eventId: randomUUID() })).toEqual(created);
  await post(caseId, 'requests', { ...draft, eventId: randomUUID(), recipientRole: 'supplier_records' }, 409);
  await post(caseId, 'requests', { ...draft, recipientRole: 'supplier_records' }, 409);
  const approval = { ...current.binding, eventId: randomUUID(), contentHash: request.contentHash };
  const approved = await post(caseId, `requests/${request.requestId}/approve`, approval);
  expect(await post(caseId, `requests/${request.requestId}/approve`, approval)).toEqual(approved);
  return request;
}
async function claimRequest(requestId: string) {
  const jobs = await harness.workerBoss.fetch(WORKFLOW_QUEUE);
  expect(jobs).toHaveLength(1);
  expect(jobs[0]!.id).toBe(requestId);
}
async function deliver(requestId: string) {
  await claimRequest(requestId);
  const response = await harness.inject({ method: 'POST', url: `${WORKFLOW_WORKER_PATH}/${requestId}/deliver`, headers });
  expect(response.statusCode, response.body).toBe(200);
  await harness.workerBoss.complete(WORKFLOW_QUEUE, requestId);
  return response.json<{ receipt: { receiptId: string }; replayed: boolean }>();
}

it('local workflow smoke: request, lost acknowledgement, restart, response, review, cancellation, conflict and current-policy recovery', async () => {
  const caseId = 'case-local-loop';
  await missingCase(caseId);
  const oldBinding = (await view(caseId)).binding;
  const request = await draftAndApprove(caseId);
  await claimRequest(request.requestId);
  expect((await harness.inject({ method: 'POST', url: `${WORKFLOW_WORKER_PATH}/${request.requestId}/deliver` })).statusCode).toBe(401);
  dropAcknowledgement = true;
  await expect(fetch(new URL(`${WORKFLOW_WORKER_PATH}/${request.requestId}/deliver`, origin), { method: 'POST', headers })).rejects.toThrow();
  const beforeRestart = await view(caseId);
  expect(beforeRestart.receipts).toHaveLength(1);
  const [operator] = await adminQuery<{ id: string }>(harness.database, "SELECT id FROM pa_app.auth_users WHERE email = 'operator@fixture.invalid'");
  expect(beforeRestart.requests[0]).toMatchObject({ state: 'simulated_delivered', approvedBy: operator!.id });
  expect(beforeRestart.requests[0]!.approvedPayload).not.toBeNull();
  await harness.app.close();
  harness.app = buildApi({ config: testApiConfig(harness.database.urls.api), db: harness.handle.db, boss: harness.apiBoss, logger: false });
  origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
  const replay = await harness.inject({ method: 'POST', url: `${WORKFLOW_WORKER_PATH}/${request.requestId}/deliver`, headers });
  expect(replay.statusCode).toBe(200);
  expect(replay.json()).toMatchObject({ replayed: true, receipt: { receiptId: beforeRestart.receipts[0]!.receiptId } });
  await harness.workerBoss.complete(WORKFLOW_QUEUE, request.requestId);
  const responseEvent = { eventId: randomUUID(), expectedRevision: 1, requestId: request.requestId, fixtureEvent: 'archive_f01' };
  const ingested = await post(caseId, 'fixture-events', responseEvent);
  expect(await post(caseId, 'fixture-events', responseEvent)).toEqual(ingested);
  expect((await view(caseId)).head).toMatchObject({ state: 'assessing', revision: 2 });
  expect((await view(caseId)).requests[0]!.state).toBe('response_received');
  await assess();
  let current = await view(caseId);
  expect(current.head.state).toBe('ready_for_review');
  expect(current.requests[0]!.state).toBe('closed');
  expect(current.receipts).toHaveLength(1);
  const review = { ...current.binding, eventId: randomUUID(), decision: 'accept_for_review', reason: 'Administrative evidence reviewed in the synthetic lab.' };
  const decision = await post(caseId, 'reviews', review);
  expect(await post(caseId, 'reviews', review)).toEqual(decision);
  expect((await view(caseId)).head.state).toBe('accepted_for_review');
  expect(decision.clinicalReviewStatus).toBe('requires_qualified_review');
  await post(caseId, 'reviews', { ...review, ...oldBinding, eventId: randomUUID() }, 409);
  await post(caseId, 'reviews', { ...review, eventId: randomUUID(), actorId: 'forged-reviewer' }, 400);
  expect(current.packets.filter((packet) => packet.superseded)).toHaveLength(1);

  // Recovery must use changed policy bytes, not an accepted checkpoint.
  const changed: CaseSnapshot = (await readCaseSnapshot(harness.handle.db, caseId, 2))!;
  changed.caseText = JSON.stringify({ ...JSON.parse(changed.caseText), revision: 3 });
  const policy = JSON.parse(changed.policyText) as { reviewedAsOf: string; supportedAssessmentDates: string[] };
  policy.reviewedAsOf = '2026-10-17';
  policy.supportedAssessmentDates = ['2026-10-17'];
  changed.policyText = JSON.stringify(policy);
  await persistCase(harness.handle.db, harness.apiBoss, changed, 2);
  const previous = await findCase(harness.handle.db, caseId);
  const recovery = await post(caseId, 'recover', { expectedRevision: 3, eventId: randomUUID() });
  expect(recovery.state).toBe('assessing');
  expect((await harness.inject(`/api/cases/${caseId}/packet`)).statusCode).toBe(409);
  const staleJobs = await harness.workerBoss.fetch(CASE_QUEUE);
  expect(staleJobs[0]!.id).toBe(previous!.currentJobId);
  expect((await harness.inject({ url: `${CASE_WORKER_PATH}/${staleJobs[0]!.id}`, headers })).statusCode).toBe(409);
  await harness.workerBoss.complete(CASE_QUEUE, staleJobs[0]!.id);
  await assess();
  current = await view(caseId);
  expect(current.binding.policyPackSha256).not.toBe(review.policyPackSha256);
  expect(current.head.state).toBe('scope_hold');
  expect(current.decisions).toHaveLength(1);
  await post(caseId, 'reviews', { ...review, eventId: randomUUID() }, 409);
  const returned = await post(caseId, 'reviews', { ...current.binding, eventId: randomUUID(), decision: 'return', reason: 'Operator follow-up requested.' });
  expect(returned).toHaveProperty('decision');
  expect((await view(caseId)).head.state).toBe('needs_human_review');

  const cancelled = 'case-cancelled-loop';
  const cancelledSnapshot = await missingCase(cancelled);
  const lateRequest = await draftAndApprove(cancelled);
  await deliver(lateRequest.requestId);
  await post(cancelled, 'cancel', { expectedRevision: 1, eventId: randomUUID() });
  const eventsBefore = await adminQuery<{ count: number }>(harness.database, 'SELECT count(*)::int AS count FROM pa_app.case_assessments WHERE case_id=$1', [cancelled]);
  const late = { expectedRevision: 1, eventId: randomUUID(), requestId: lateRequest.requestId, fixtureEvent: 'archive_f01' };
  expect(await post(cancelled, 'fixture-events', late)).toMatchObject({ disposition: 'late_audit_only', state: 'cancelled' });
  expect((await view(cancelled)).responses).toEqual([{ eventId: late.eventId, fixtureEvent: 'archive_f01', disposition: 'late_audit_only' }]);
  expect(await adminQuery(harness.database, 'SELECT count(*)::int AS count FROM pa_app.case_assessments WHERE case_id=$1', [cancelled])).toEqual(eventsBefore);
  await post(cancelled, 'recover', { expectedRevision: 1, eventId: randomUUID() }, 409);
  await post(cancelled, 'assess', { expectedRevision: 1 }, 409);
  cancelledSnapshot.caseText = JSON.stringify({ ...JSON.parse(cancelledSnapshot.caseText), revision: 2 });
  await expect(persistCase(harness.handle.db, harness.apiBoss, cancelledSnapshot, 1)).rejects.toThrow('terminal');

  const conflictId = 'case-f24-flow';
  await missingCase(conflictId, 'F05b');
  const conflictingRequest = await draftAndApprove(conflictId);
  await deliver(conflictingRequest.requestId);
  await post(conflictId, 'fixture-events', { expectedRevision: 1, eventId: randomUUID(), requestId: conflictingRequest.requestId, fixtureEvent: 'archive_f05b' });
  await assess();
  const conflicting = await view(conflictId);
  expect(conflicting.requests[0]!.state).toBe('closed');
  expect(conflicting.head.state).toBe('needs_human_review');
  expect(conflicting.packets.find((packet) => !packet.superseded)!.packet.findings.find((finding) => finding.ruleId === 'R04')!.conditions).toContainEqual(expect.objectContaining({ conditionKey: 'R04.order_before_encounter' }));
  await post(conflictId, 'reviews', { ...conflicting.binding, eventId: randomUUID(), decision: 'accept_for_review', reason: 'Cannot accept a conflict.' }, 409);

  // Cancellation wins a queued claim; material change invalidates an approval.
  const pending = 'case-pending-cancel';
  await missingCase(pending);
  const pendingRequest = await draftAndApprove(pending);
  await post(pending, 'cancel', { expectedRevision: 1, eventId: randomUUID() });
  await expect(deliverRequest(harness.handle.db, pendingRequest.requestId)).rejects.toThrow('approval required');
  expect((await view(pending)).receipts).toHaveLength(0);
  const [queuedPending] = (await harness.workerBoss.fetch(WORKFLOW_QUEUE));
  await harness.workerBoss.complete(WORKFLOW_QUEUE, queuedPending!.id);


  const staleId = 'case-stale-approval';
  const staleSnapshot = await missingCase(staleId);
  const staleRequest = await draftAndApprove(staleId);
  const staleBinding = (await view(staleId)).binding;
  staleSnapshot.caseText = JSON.stringify({ ...JSON.parse(staleSnapshot.caseText), revision: 2 });
  await persistCase(harness.handle.db, harness.apiBoss, staleSnapshot, 1);
  await expect(deliverRequest(harness.handle.db, staleRequest.requestId)).rejects.toThrow('approval required');
  await post(staleId, `requests/${staleRequest.requestId}/approve`, { ...staleBinding, contentHash: staleRequest.contentHash, eventId: randomUUID() }, 409);
  expect((await view(staleId)).receipts).toHaveLength(0);
  const [staleJob] = await harness.workerBoss.fetch(WORKFLOW_QUEUE);
  await harness.workerBoss.complete(WORKFLOW_QUEUE, staleJob!.id);
  await assess();
  const freshRequest = await draftAndApprove(staleId);
  // Exercise the registered request consumer against the real internal API.
  await startWorkflowJobs(harness.workerBoss, origin, authorization, 1, new Set(), () => Promise.resolve());
  await expect.poll(async () => (await view(staleId)).requests.find((item) => item.requestId === freshRequest.requestId)?.state, { timeout: 5000 }).toBe('simulated_delivered');
  await harness.workerBoss.offWork(WORKFLOW_QUEUE, { wait: true });
  expect((await view(staleId)).receipts).toHaveLength(1);

  process.stdout.write('local workflow smoke: one receipt after lost acknowledgement and API reconstruction; finalized archive reply reassessed; old revision rejected; exact packet accepted and returned; cancelled late reply audit-only; F24 missing order closed with date conflict retained; changed-policy recovery reassessed current bytes.\n');
});

it('lets the operator close a delivered request whose reply did not resolve the rule, so a follow-up can be drafted', async () => {
  const caseId = 'case-close-unresolved';
  await missingCase(caseId);
  const request = await draftAndApprove(caseId);
  await deliver(request.requestId);
  const current = await view(caseId);
  const finding = current.packets.find((item) => !item.superseded)!.packet.findings.find((item) => item.ruleId === 'R03')!;
  const followUp = { ...current.binding, findingId: finding.findingId, templateId: 'existing_order', recipientRole: 'practitioner_records', idempotencyKey: randomUUID(), eventId: randomUUID() };
  await post(caseId, 'requests', followUp, 409);

  const close = { eventId: randomUUID() };
  expect((await harness.inject({ method: 'POST', url: `/api/cases/${caseId}/requests/${request.requestId}/close`, as: 'reviewer', payload: close })).statusCode).toBe(403);
  const closed = await post(caseId, `requests/${request.requestId}/close`, close);
  expect(closed).toEqual({ requestId: request.requestId, state: 'closed' });
  expect(await post(caseId, `requests/${request.requestId}/close`, close)).toEqual(closed);
  await post(caseId, `requests/${request.requestId}/close`, { eventId: randomUUID() }, 409);

  const drafted = await post(caseId, 'requests', { ...followUp, eventId: randomUUID() });
  expect((drafted.request as { state: string }).state).toBe('draft');
  const after = await view(caseId);
  expect(after.requests.map((item) => item.state).sort()).toEqual(['closed', 'draft']);
  expect(after.receipts).toHaveLength(1);
  expect(after.head.state).toBe(current.head.state);
});
