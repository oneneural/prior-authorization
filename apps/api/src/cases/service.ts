import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, eq } from 'drizzle-orm';

import { assessmentInput, sourceHash, validateSnapshot } from '@pa/connectors';
import { CASE_NOTICE, CASE_QUEUE, CasePacket, DocumentExact, IntakeCaseV2, SourceDocumentBodyExact, type AssessmentOutcomeV3, type CaseSnapshot, type CaseResultReport, type SessionActor } from '@pa/contracts';
import { caseAssessments, caseBlobs, caseDocuments, caseEvents, caseRevisions, cases, documentRequests, enqueueCaseJob, findCase, findCaseAssessment, lockCase, readCaseSnapshot, type Database, type PgBoss, type Transaction } from '@pa/db';
import { assessV2, nodeAt, readJsonSource } from '@pa/domain';

import { FIXTURE_TEAM } from '../auth/index.js';

/** A signed-in actor, or null for a trusted internal path already scoped by its job or run. */
export type Scope = SessionActor | null;
const actorId = (scope: Scope, fallback = 'agent-worker') => scope?.userId ?? fallback;
export class CaseError extends Error {
  constructor(readonly statusCode: number, message: string) { super(message); }
}
const denied = () => new CaseError(404, 'case resource unavailable');
const stale = () => new CaseError(409, 'case revision or job no longer current');

/** Case scope is the actor's team; an unknown and an out-of-scope case look the same. */
export function inScope(row: { ownerId: string } | undefined, scope: Scope): boolean {
  return row !== undefined && (scope === null || row.ownerId === scope.teamId);
}

export async function authorizedCase(db: Database, caseId: string, scope: SessionActor) {
  const row = await findCase(db, caseId);
  if (row === undefined || !inScope(row, scope)) throw denied();
  return row;
}

export async function event(tx: Transaction, caseId: string, revision: number, type: string, payload: unknown, correlationId: string, actor = 'fixture-intake') {
  await tx.insert(caseEvents).values({ eventId: randomUUID(), caseId, inputRevision: revision, type, actor, payloadHash: sourceHash(JSON.stringify(payload)), correlationId });
}

export async function enqueue(tx: Transaction, boss: PgBoss, caseId: string, revision: number, actor = 'fixture-intake') {
  const jobId = randomUUID();
  await tx.insert(caseAssessments).values({ jobId, caseId, revision });
  await enqueueCaseJob(boss, tx, jobId, { caseId, revision });
  await event(tx, caseId, revision, 'assessment_queued', { jobId }, jobId, actor);
  await tx.update(cases).set({ state: 'assessing', currentJobId: jobId }).where(eq(cases.caseId, caseId));
  return jobId;
}

/** Trusted fixture ingestion only, never exposed as a public upload route. */
export async function persistCase(db: Database, boss: PgBoss, input: CaseSnapshot, expectedRevision: number | null = null) {
  return db.transaction((tx) => persistCaseRevision(tx, boss, input, expectedRevision));
}

export async function persistCaseRevision(tx: Transaction, boss: PgBoss, input: CaseSnapshot, expectedRevision: number | null = null) {
  const snapshot = validateSnapshot(input);
  const record = IntakeCaseV2.parse(JSON.parse(snapshot.caseText));

  // Serialises competing initial seeds as well as revision changes.
  await tx.insert(cases).values({ caseId: record.caseId, ownerId: FIXTURE_TEAM, revision: record.revision, state: 'intake' }).onConflictDoNothing();
  const head = await lockCase(tx, record.caseId);
  if (head === undefined || head.ownerId !== FIXTURE_TEAM) throw denied();
  const existing = await readCaseSnapshot(tx, record.caseId, head.revision);
  if (expectedRevision === null && existing !== undefined) return { caseId: record.caseId, created: false, jobId: null };
  if (head.state === 'cancelled') throw new CaseError(409, 'cancelled cases are terminal');
  if ((expectedRevision === null && record.revision !== 1) || (expectedRevision !== null && (head.revision !== expectedRevision || record.revision !== expectedRevision + 1))) throw stale();
  async function blob(content: string) {
    const hash = sourceHash(content);
    await tx.insert(caseBlobs).values({ hash, content }).onConflictDoNothing();
    return hash;
  }
  const refs = [];
  const previousRefs = (await tx.select().from(caseDocuments).where(eq(caseDocuments.caseId, record.caseId))).map((doc) => `${doc.documentId}@${doc.version}`);
  for (const doc of snapshot.documents) {
    const metadata = DocumentExact.parse(JSON.parse(doc.metadataText));
    const blobHash = doc.payload === null ? null : await blob(doc.payload);
    const key = and(eq(caseDocuments.caseId, record.caseId), eq(caseDocuments.documentId, metadata.documentId), eq(caseDocuments.version, metadata.version));
    const prior = (await tx.select().from(caseDocuments).where(key))[0];
    if (prior !== undefined && (prior.metadataText !== doc.metadataText || prior.blobHash !== blobHash)) throw new CaseError(409, 'document versions are immutable');
    if (prior === undefined) await tx.insert(caseDocuments).values({ caseId: record.caseId, documentId: metadata.documentId, version: metadata.version, metadataText: doc.metadataText, blobHash });
    refs.push({ slot: doc.slot, documentId: metadata.documentId, version: metadata.version });
  }
  const retained = new Set(refs.map((ref) => `${ref.documentId}@${ref.version}`));
  if (previousRefs.some((ref) => !retained.has(ref))) throw new CaseError(409, 'source version history must be retained');
  await tx.insert(caseRevisions).values({ caseId: record.caseId, revision: record.revision, caseText: snapshot.caseText, policyHash: await blob(snapshot.policyText), documentRefs: refs });
  for (const request of await tx.select().from(documentRequests).where(eq(documentRequests.caseId, record.caseId))) {
    if (['draft', 'approved_local'].includes(request.state)) await tx.update(documentRequests).set({ state: 'cancelled' }).where(eq(documentRequests.requestId, request.requestId));
  }
  await tx.update(cases).set({ revision: record.revision, state: 'intake' }).where(eq(cases.caseId, record.caseId));
  await event(tx, record.caseId, record.revision, 'case_revision_created', { policyHash: sourceHash(snapshot.policyText), refs }, randomUUID());
  return { caseId: record.caseId, created: true, jobId: await enqueue(tx, boss, record.caseId, record.revision) };
}

export async function assessCase(db: Database, boss: PgBoss, caseId: string, expectedRevision: number, actor: SessionActor) {
  await authorizedCase(db, caseId, actor);
  return db.transaction(async (tx) => {
    const head = await lockCase(tx, caseId);
    if (head === undefined || !inScope(head, actor)) throw denied();
    if (head.revision !== expectedRevision) throw stale();
    if (head.state === 'cancelled') throw new CaseError(409, 'cancelled cases are terminal');
    return enqueue(tx, boss, caseId, expectedRevision, actorId(actor));
  });
}

export async function jobScope(db: Database, boss: PgBoss, jobId: string) {
  const job = await findCaseAssessment(db, jobId);
  if (job === undefined) throw denied();
  const head = await findCase(db, job.caseId);
  const queued = await boss.getJobById(CASE_QUEUE, jobId);
  if (queued?.state !== 'active' || head?.revision !== job.revision || head.currentJobId !== jobId || head.state !== 'assessing') throw stale();
  const snapshot = await readCaseSnapshot(db, job.caseId, job.revision);
  if (snapshot === undefined) throw denied();
  validateSnapshot(snapshot);
  return { jobId, caseId: job.caseId, revision: job.revision, snapshot };
}

export function buildPacket(snapshot: CaseSnapshot, outcome: AssessmentOutcomeV3): CasePacket | null {
  if (outcome.outcome !== 'assessed') return null;
  const result = outcome.result;
  const failedSources = result.findings.filter((finding) => finding.ruleId === 'R09').flatMap((finding) => finding.conditions.flatMap((condition) => condition.documentRefs));
  const excluded = new Set([...result.quarantinedDocuments, ...result.supersededDocuments, ...failedSources].map((ref) => `${ref.documentId}@${ref.version}`));
  const documents = snapshot.documents.flatMap((doc) => {
    const metadata = DocumentExact.parse(JSON.parse(doc.metadataText));
    return doc.payload === null || metadata.accessStatus !== 'available' || metadata.mimeType !== 'application/json' || metadata.kind === 'supporting_note' || excluded.has(`${metadata.documentId}@${metadata.version}`)
      ? [] : [{ metadata, payload: doc.payload }];
  });
  const included = new Set(documents.map((doc) => `${doc.metadata.documentId}@${doc.metadata.version}`));
  const body = {
    schemaVersion: 'pa.packet.v1' as const, packetId: `packet-${result.caseId}-r${result.caseRevision}`, caseId: result.caseId, caseRevision: result.caseRevision,
    policyPackId: result.policyPackId, policyPackSha256: result.policyPackSha256,
    includedDocumentRefs: documents.map(({ metadata }) => ({ documentId: metadata.documentId, version: metadata.version })), documents,
    evidenceFacts: result.evidenceFacts.filter((fact) => included.has(`${fact.documentId}@${fact.documentVersion}`)),
    // Findings remain explicit, including identity and unavailable-evidence issues, without excluded source text.
    findings: result.findings.map((finding) => ({ ...finding, evidenceFactIds: finding.evidenceFactIds.filter((id) => result.evidenceFacts.some((fact) => fact.factId === id && included.has(`${fact.documentId}@${fact.documentVersion}`))) })),
    clinicalReviewRequired: true as const, clinicalReviewStatus: 'requires_qualified_review' as const, mode: 'rules_only' as const, notice: CASE_NOTICE,
    limitations: ['Original synthetic inputs only.', 'Clinical questions require qualified review.', 'Signature metadata is not signer authentication.', 'Administrative packet only; no authorization, payment or delivery decision.'],
  };
  return CasePacket.parse({ ...body, packetHash: sourceHash(JSON.stringify(body)) });
}

export async function recordCaseResult(db: Database, boss: PgBoss, jobId: string, report: CaseResultReport) {
  return db.transaction(async (tx) => {
    const job = await findCaseAssessment(tx, jobId);
    if (job === undefined || job.caseId !== report.caseId || job.revision !== report.revision) throw denied();
    const head = await lockCase(tx, job.caseId);
    if (head?.revision !== job.revision) throw stale();
    const current = await findCaseAssessment(tx, jobId);
    if (current?.outcome !== null && current?.outcome !== undefined) {
      if (!isDeepStrictEqual(current.outcome, report.outcome)) throw new CaseError(409, 'result conflict');
      return { replayed: true };
    }
    if (head.currentJobId !== jobId || head.state !== 'assessing' || (await boss.getJobById(CASE_QUEUE, jobId))?.state !== 'active') throw stale();
    const snapshot = await readCaseSnapshot(tx, job.caseId, job.revision);
    if (snapshot === undefined) throw denied();
    // API verifies untrusted worker output against the exact current bytes and deterministic gates.
    const authoritative = await assessV2(assessmentInput(validateSnapshot(snapshot)));
    if (!isDeepStrictEqual(authoritative, report.outcome)) throw new CaseError(409, 'assessment does not match current source bytes');
    const packet = buildPacket(snapshot, authoritative);
    await tx.update(caseAssessments).set({ outcome: authoritative, packet }).where(eq(caseAssessments.jobId, jobId));
    const state = authoritative.outcome === 'assessed' ? authoritative.result.state : 'needs_human_review';
    await tx.update(cases).set({ state }).where(eq(cases.caseId, job.caseId));
    if (authoritative.outcome === 'assessed') {
      const requests = await tx.select().from(documentRequests).where(eq(documentRequests.caseId, job.caseId));
      for (const request of requests) {
        if (!['simulated_delivered', 'response_received'].includes(request.state)) continue;
        const finding = authoritative.result.findings.find((candidate) => candidate.ruleId === request.ruleId);
        if (finding?.status === 'pass') {
          await tx.update(documentRequests).set({ state: 'closed' }).where(eq(documentRequests.requestId, request.requestId));
          await event(tx, job.caseId, job.revision, 'request_closed_after_reassessment', { requestId: request.requestId }, jobId);
        }
      }
    }
    await event(tx, job.caseId, job.revision, 'assessment_recorded', authoritative, jobId, 'rules-worker');
    return { replayed: false };
  });
}

export async function currentAssessment(db: Database, caseId: string, revision: number) {
  const head = await findCase(db, caseId);
  if (head?.revision !== revision || head.currentJobId === null) return undefined;
  return findCaseAssessment(db, head.currentJobId);
}

/** Quarantined and R09-failed versions are withheld from every reader, including agent tools. */
export function isWithheld(outcome: AssessmentOutcomeV3 & { outcome: 'assessed' }, documentId: string, version: number) {
  const matches = (ref: { documentId: string; version: number }) => ref.documentId === documentId && ref.version === version;
  return outcome.result.quarantinedDocuments.some(matches)
    || outcome.result.findings.some((finding) => finding.ruleId === 'R09' && finding.conditions.some((condition) => condition.documentRefs.some(matches)));
}

export function sourceAt(snapshot: CaseSnapshot, documentId: string, version: number, pointer?: string) {
  const record = IntakeCaseV2.parse(JSON.parse(snapshot.caseText));
  const doc = snapshot.documents.find((candidate) => { const meta = DocumentExact.parse(JSON.parse(candidate.metadataText)); return meta.documentId === documentId && meta.version === version; });
  if (doc === undefined || doc.payload === null) throw denied();
  const metadata = DocumentExact.parse(JSON.parse(doc.metadataText));
  if (metadata.accessStatus !== 'available' || metadata.mimeType !== 'application/json') throw denied();
  if (metadata.subjectId !== null && metadata.subjectId !== record.subjectId) throw denied();
  if (sourceHash(doc.payload) !== metadata.contentHash) throw new CaseError(409, 'source hash mismatch');
  // R09 can stop before body binding, so metadata alone never authorizes source bytes.
  let body: SourceDocumentBodyExact;
  try {
    body = SourceDocumentBodyExact.parse(JSON.parse(doc.payload));
  } catch {
    throw denied();
  }
  if (body.documentKind !== metadata.kind) throw denied();
  if (body.documentKind !== 'supplier_status' && (
    (body.beneficiary.identifier !== null && body.beneficiary.identifier !== record.subjectId) ||
    (body.beneficiary.name !== null && body.beneficiary.name !== record.subjectName)
  )) throw denied();
  if (pointer === undefined) return { metadata, payload: doc.payload };
  const node = nodeAt(readJsonSource(doc.payload), pointer);
  if (node?.kind !== 'scalar') throw denied();
  return { documentId, version, contentHash: metadata.contentHash, locator: pointer, value: node.value, originalText: typeof node.value === 'string' ? node.value : node.raw };
}
