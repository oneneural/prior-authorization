import { and, eq } from 'drizzle-orm';

import type { CaseSnapshot } from '@pa/contracts';

import type { Queryable, Transaction } from './client.js';
import { caseAssessments, caseBlobs, caseDocuments, caseEvents, caseRevisions, cases } from './schema.js';

export { caseAssessments, caseBlobs, caseDocuments, caseEvents, caseRevisions, cases };
export type CaseRow = typeof cases.$inferSelect;
export type AssessmentRow = typeof caseAssessments.$inferSelect;

export async function findCase(db: Queryable, caseId: string): Promise<CaseRow | undefined> {
  return (await db.select().from(cases).where(eq(cases.caseId, caseId)))[0];
}
export async function lockCase(tx: Transaction, caseId: string): Promise<CaseRow | undefined> {
  return (await tx.select().from(cases).where(eq(cases.caseId, caseId)).for('update'))[0];
}
export async function listCases(db: Queryable, ownerId: string): Promise<CaseRow[]> {
  return db.select().from(cases).where(eq(cases.ownerId, ownerId)).orderBy(cases.caseId);
}
export async function findCaseAssessment(db: Queryable, jobId: string): Promise<AssessmentRow | undefined> {
  return (await db.select().from(caseAssessments).where(eq(caseAssessments.jobId, jobId)))[0];
}
export async function readCaseSnapshot(db: Queryable, caseId: string, revision: number): Promise<CaseSnapshot | undefined> {
  const record = (await db.select().from(caseRevisions).where(and(eq(caseRevisions.caseId, caseId), eq(caseRevisions.revision, revision))))[0];
  if (record === undefined) return undefined;
  async function content(hash: string): Promise<string> {
    const blob = (await db.select().from(caseBlobs).where(eq(caseBlobs.hash, hash)))[0];
    if (blob === undefined) throw new Error('persisted source blob missing');
    return blob.content;
  }
  const documents: CaseSnapshot['documents'] = [];
  for (const ref of record.documentRefs) {
    const doc = (await db.select().from(caseDocuments).where(and(eq(caseDocuments.caseId, caseId), eq(caseDocuments.documentId, ref.documentId), eq(caseDocuments.version, ref.version))))[0];
    if (doc === undefined) throw new Error('persisted document missing');
    documents.push({ slot: ref.slot, metadataText: doc.metadataText, payload: doc.blobHash === null ? null : await content(doc.blobHash) });
  }
  return { caseText: record.caseText, policyText: await content(record.policyHash), documents };
}
