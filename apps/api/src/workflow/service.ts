import { randomUUID } from 'node:crypto';

import { and, eq, sql } from 'drizzle-orm';

import { loadFixture, sourceHash, validateSnapshot } from '@pa/connectors';
import {
  CASE_NOTICE, DocumentExact, IntakeCaseV2, RequestProposal,
  type ApproveRequestCommand, type CaseActionCommand, type CloseRequestCommand, type FixtureResponseCommand,
  type ProposeRequestCommand, type ReviewPacketCommand, type RevisionBinding, type SessionActor,
} from '@pa/contracts';
import {
  caseAssessments, cases, documentRequests, enqueueWorkflowJob, findCaseAssessment, findReceipt, findRequest,
  localReceipts, lockCase, readCaseSnapshot, reviewDecisions, workflowCommands, workflowResponses,
  type CaseRow, type Database, type PgBoss, type Queryable, type Transaction,
} from '@pa/db';

import { authorizedCase, CaseError, enqueue, event, inScope, persistCaseRevision, type Scope } from '../cases/service.js';
import { requestTemplate } from './templates.js';

export function payloadHash(value: unknown): string {
  function canonical(item: unknown): unknown {
    if (Array.isArray(item)) return item.map(canonical);
    if (item !== null && typeof item === 'object') return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => [key, canonical(child)]));
    return item;
  }
  return sourceHash(JSON.stringify(canonical(value)));
}

const conflict = (message: string) => new CaseError(409, message);
function active(head: CaseRow, revision: number) {
  if (head.state === 'cancelled') throw conflict('cancelled cases are terminal');
  if (head.revision !== revision) throw conflict('case revision no longer current');
}

export async function revisionBinding(db: Queryable, head: CaseRow): Promise<RevisionBinding> {
  if (head.currentJobId === null || head.state === 'assessing' || head.state === 'recoverable_error' || head.state === 'cancelled') throw conflict('fresh assessment required');
  const assessment = await findCaseAssessment(db, head.currentJobId);
  const snapshot = await readCaseSnapshot(db, head.caseId, head.revision);
  if (assessment?.packet == null || snapshot === undefined) throw conflict('current packet unavailable');
  return {
    expectedRevision: head.revision, sourceRevisionHash: sourceHash(JSON.stringify(snapshot)),
    policyPackSha256: sourceHash(snapshot.policyText), packetHash: assessment.packet.packetHash,
  };
}

async function checkBinding(tx: Queryable, head: CaseRow, supplied: RevisionBinding) {
  active(head, supplied.expectedRevision);
  const current = await revisionBinding(tx, head);
  if (current.sourceRevisionHash !== supplied.sourceRevisionHash || current.policyPackSha256 !== supplied.policyPackSha256 || current.packetHash !== supplied.packetHash) {
    throw conflict('source, policy or packet revision no longer current');
  }
}

/** One lock orders approval, execution, response, cancellation and recovery. */
export async function command(db: Database, scope: Scope, caseId: string, operation: string, input: { eventId: string }, run: (tx: Transaction, head: CaseRow) => Promise<Record<string, unknown>>) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${input.eventId}))`);
    const head = await lockCase(tx, caseId);
    if (head === undefined || !inScope(head, scope)) throw new CaseError(404, 'case resource unavailable');
    const hash = payloadHash(input);
    const previous = (await tx.select().from(workflowCommands).where(eq(workflowCommands.eventId, input.eventId)))[0];
    if (previous !== undefined) {
      if (previous.caseId !== caseId || previous.operation !== operation || previous.payloadHash !== hash) throw conflict('event ID reused with changed payload');
      return previous.result;
    }
    const result = await run(tx, head);
    await tx.insert(workflowCommands).values({ eventId: input.eventId, caseId, operation, payloadHash: hash, result });
    await event(tx, caseId, head.revision, operation, input, input.eventId, scope?.userId ?? 'agent-worker');
    return result;
  });
}

export async function proposeRequest(db: Database, scope: Scope, caseId: string, input: ProposeRequestCommand) {
  return command(db, scope, caseId, 'request_drafted', input, async (tx, head) => {
    const proposal = RequestProposal.parse(Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'eventId' && key !== 'idempotencyKey')));
    const hash = payloadHash(proposal);
    const previous = (await tx.select().from(documentRequests).where(and(eq(documentRequests.caseId, caseId), eq(documentRequests.idempotencyKey, input.idempotencyKey))))[0];
    if (previous !== undefined) {
      if (previous.proposalHash !== hash) throw conflict('idempotency key reused with changed payload');
      return { request: previous };
    }
    await checkBinding(tx, head, input);
    const assessment = await findCaseAssessment(tx, head.currentJobId!);
    const finding = assessment?.outcome?.outcome === 'assessed' ? assessment.outcome.result.findings.find((item) => item.findingId === proposal.findingId) : undefined;
    const template = requestTemplate(proposal, finding);
    // Avoid another request for the same unresolved requirement under another key.
    const outstanding = (await tx.select().from(documentRequests).where(eq(documentRequests.caseId, caseId)))
      .find((item) => item.ruleId === finding!.ruleId && !['closed', 'cancelled'].includes(item.state));
    if (outstanding !== undefined) throw conflict('an unresolved request already exists for this finding');
    const payload = { ...proposal, caseId, body: template.body };
    const [request] = await tx.insert(documentRequests).values({
      requestId: randomUUID(), caseId, caseRevision: head.revision, idempotencyKey: input.idempotencyKey,
      proposalHash: hash, findingId: proposal.findingId, ruleId: finding!.ruleId, conditionKeys: template.conditionKeys,
      payload, contentHash: payloadHash(payload),
    }).returning();
    return { request };
  });
}

export async function approveRequest(db: Database, boss: PgBoss, actor: SessionActor, caseId: string, requestId: string, input: ApproveRequestCommand) {
  return command(db, actor, caseId, `request_approved:${requestId}`, input, async (tx, head) => {
    await checkBinding(tx, head, input);
    const request = await findRequest(tx, caseId, requestId);
    if (request === undefined) throw new CaseError(404, 'request unavailable');
    if (request.contentHash !== input.contentHash || request.caseRevision !== head.revision || request.payload.packetHash !== input.packetHash || request.payload.sourceRevisionHash !== input.sourceRevisionHash || request.payload.policyPackSha256 !== input.policyPackSha256) throw conflict('request approval is stale');
    if (request.state !== 'draft') throw conflict('request is no longer a draft');
    await tx.update(documentRequests).set({ state: 'approved_local', approvedPayload: request.payload, approvedBy: actor.userId, approvedAt: new Date() }).where(eq(documentRequests.requestId, requestId));
    await enqueueWorkflowJob(boss, tx, requestId, requestId, head.revision);
    return { requestId, state: 'approved_local', contentHash: request.contentHash };
  });
}

/** Simulated adapter and receipt are local transactional writes. No transmission exists. */
export async function deliverRequest(db: Database, requestId: string) {
  const stored = (await db.select().from(documentRequests).where(eq(documentRequests.requestId, requestId)))[0];
  if (stored === undefined) throw new CaseError(404, 'request unavailable');
  return db.transaction(async (tx) => {
    const head = await lockCase(tx, stored.caseId);
    if (head === undefined) throw new CaseError(404, 'case unavailable');
    const receipt = await findReceipt(tx, requestId);
    if (receipt !== undefined) return { receipt, replayed: true };
    const request = await findRequest(tx, stored.caseId, requestId);
    if (request?.approvedPayload == null || request.approvedBy === null || request.state !== 'approved_local') throw conflict('explicit local approval required');
    await checkBinding(tx, head, request.approvedPayload);
    if (payloadHash(request.approvedPayload) !== request.contentHash) throw conflict('approved payload hash mismatch');
    const [created] = await tx.insert(localReceipts).values({ receiptId: randomUUID(), requestId, contentHash: request.contentHash }).returning();
    await tx.update(documentRequests).set({ state: 'simulated_delivered' }).where(eq(documentRequests.requestId, requestId));
    await event(tx, head.caseId, head.revision, 'request_simulated_delivered', { requestId, contentHash: request.contentHash }, requestId);
    return { receipt: created, replayed: false };
  });
}

/** An operator closes a delivered request whose reply did not resolve its rule. Nothing is sent. */
export async function closeRequest(db: Database, actor: SessionActor, caseId: string, requestId: string, input: CloseRequestCommand) {
  return command(db, actor, caseId, `request_closed:${requestId}`, input, async (tx, head) => {
    if (head.state === 'cancelled') throw conflict('cancelled cases are terminal');
    const request = await findRequest(tx, caseId, requestId);
    if (request === undefined) throw new CaseError(404, 'request unavailable');
    if (!['simulated_delivered', 'response_received'].includes(request.state)) throw conflict('only a delivered request can be closed');
    await tx.update(documentRequests).set({ state: 'closed' }).where(eq(documentRequests.requestId, requestId));
    return { requestId, state: 'closed' };
  });
}

export async function reviewPacket(db: Database, actor: SessionActor, caseId: string, input: ReviewPacketCommand) {
  return command(db, actor, caseId, 'packet_reviewed', input, async (tx, head) => {
    await checkBinding(tx, head, input);
    if (input.decision === 'accept_for_review' && head.state !== 'ready_for_review') throw conflict('packet is not administratively ready for review');
    const { expectedRevision, sourceRevisionHash, policyPackSha256, packetHash } = input;
    const [decision] = await tx.insert(reviewDecisions).values({ decisionId: randomUUID(), caseId, actorId: actor.userId, role: actor.role, binding: { expectedRevision, sourceRevisionHash, policyPackSha256, packetHash }, decision: input.decision, reason: input.reason }).returning();
    await tx.update(cases).set({ state: input.decision === 'accept_for_review' ? 'accepted_for_review' : 'needs_human_review' }).where(eq(cases.caseId, caseId));
    return { decision, clinicalReviewStatus: 'requires_qualified_review', notice: CASE_NOTICE };
  });
}

export async function caseAction(db: Database, boss: PgBoss, actor: SessionActor, caseId: string, action: 'cancel' | 'recover', input: CaseActionCommand) {
  return command(db, actor, caseId, action, input, async (tx, head) => {
    active(head, input.expectedRevision);
    // Unexecuted approvals must be redrafted and explicitly reapproved after recovery.
    const requests = await tx.select().from(documentRequests).where(eq(documentRequests.caseId, caseId));
    for (const request of requests) {
      if (action === 'cancel' ? !['closed', 'cancelled'].includes(request.state) : ['draft', 'approved_local'].includes(request.state)) {
        await tx.update(documentRequests).set({ state: 'cancelled' }).where(eq(documentRequests.requestId, request.requestId));
      }
    }
    if (action === 'cancel') {
      await tx.update(cases).set({ state: 'cancelled' }).where(eq(cases.caseId, caseId));
      return { state: 'cancelled' };
    }
    return { state: 'assessing', jobId: await enqueue(tx, boss, caseId, head.revision, actor.userId) };
  });
}

export async function fixtureResponse(db: Database, boss: PgBoss, actor: SessionActor, caseId: string, input: FixtureResponseCommand) {
  // Fixed archive inputs only, never caller text, paths or generated clinical content.
  const archive = await loadFixture(input.fixtureEvent === 'archive_f01' ? 'F01' : 'F05b');
  return command(db, actor, caseId, 'fixture_response', input, async (tx, head) => {
    const request = await findRequest(tx, caseId, input.requestId);
    if (request === undefined || await findReceipt(tx, request.requestId) === undefined) throw conflict('delivered request required');
    const current = (await readCaseSnapshot(tx, caseId, head.revision))!;
    const record = IntakeCaseV2.parse(JSON.parse(current.caseText));
    const subject = IntakeCaseV2.parse(JSON.parse(archive.caseText));
    if (record.subjectId !== subject.subjectId || record.subjectName !== subject.subjectName) throw conflict('fixture response subject mismatch');
    if (head.state === 'cancelled') {
      await tx.insert(workflowResponses).values({ eventId: input.eventId, requestId: request.requestId, caseId, fixtureEvent: input.fixtureEvent, snapshot: archive, disposition: 'late_audit_only' });
      return { disposition: 'late_audit_only', state: 'cancelled' };
    }
    active(head, input.expectedRevision);
    if (request.state !== 'simulated_delivered' && request.state !== 'response_received') throw conflict('request cannot receive another response');
    const identities = new Set(current.documents.map((doc) => { const meta = DocumentExact.parse(JSON.parse(doc.metadataText)); return `${meta.documentId}@${meta.version}`; }));
    const additions = archive.documents.filter((doc) => { const meta = DocumentExact.parse(JSON.parse(doc.metadataText)); return ['order', 'order_receipt'].includes(meta.kind) && !identities.has(`${meta.documentId}@${meta.version}`); });
    const snapshot = validateSnapshot({ ...current, caseText: JSON.stringify({ ...record, revision: head.revision + 1 }), documents: [...current.documents, ...additions] });
    const saved = await persistCaseRevision(tx, boss, snapshot, head.revision);
    await tx.insert(workflowResponses).values({ eventId: input.eventId, requestId: request.requestId, caseId, fixtureEvent: input.fixtureEvent, snapshot: archive, disposition: 'reassessment_queued' });
    await tx.update(documentRequests).set({ state: 'response_received' }).where(eq(documentRequests.requestId, request.requestId));
    return { disposition: 'reassessment_queued', revision: head.revision + 1, jobId: saved.jobId };
  });
}

export async function workflowView(db: Database, actor: SessionActor, caseId: string) {
  const head = await authorizedCase(db, caseId, actor);
  const requests = await db.select().from(documentRequests).where(eq(documentRequests.caseId, caseId));
  const history = await db.select().from(caseAssessments).where(eq(caseAssessments.caseId, caseId));
  return {
    notice: CASE_NOTICE, head, binding: await revisionBinding(db, head).catch((error: unknown) => { if (error instanceof CaseError) return null; throw error; }), requests,
    receipts: (await Promise.all(requests.map((request) => findReceipt(db, request.requestId)))).filter((receipt) => receipt !== undefined),
    packets: history.filter((row) => row.packet !== null).map((row) => ({ packet: row.packet, superseded: row.jobId !== head.currentJobId || ['assessing', 'recoverable_error', 'cancelled'].includes(head.state) })),
    decisions: await db.select().from(reviewDecisions).where(eq(reviewDecisions.caseId, caseId)),
    responses: (await db.select({ eventId: workflowResponses.eventId, disposition: workflowResponses.disposition, fixtureEvent: workflowResponses.fixtureEvent }).from(workflowResponses).where(eq(workflowResponses.caseId, caseId))),
  };
}

export async function recordWorkflowFailure(db: Database, caseId: string, revision: number, code: string, assessmentJobId?: string, requestId?: string) {
  return db.transaction(async (tx) => {
    const head = await lockCase(tx, caseId);
    if (head?.revision !== revision || head.state === 'cancelled' || head.state === 'recoverable_error' || (assessmentJobId !== undefined && (head.currentJobId !== assessmentJobId || head.state !== 'assessing'))) return;
    if (requestId !== undefined) {
      const request = await findRequest(tx, caseId, requestId);
      if (request?.state !== 'approved_local' || await findReceipt(tx, requestId) !== undefined) return;
    }
    await tx.update(cases).set({ state: 'recoverable_error' }).where(eq(cases.caseId, caseId));
    await event(tx, caseId, revision, `operator_action_required:${code}`, { code }, randomUUID(), 'rules-worker');
  });
}

export async function requestScope(db: Database, requestId: string) {
  const request = (await db.select().from(documentRequests).where(eq(documentRequests.requestId, requestId)))[0];
  if (request === undefined) throw new CaseError(404, 'request unavailable');
  return { caseId: request.caseId, revision: request.caseRevision };
}
