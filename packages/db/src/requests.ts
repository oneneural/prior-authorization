import { and, eq } from 'drizzle-orm';
import type { Queryable } from './client.js';
import { documentRequests, localReceipts } from './schema.js';
export { documentRequests, localReceipts, workflowCommands, workflowResponses } from './schema.js';
export type RequestRow = typeof documentRequests.$inferSelect;
export async function findRequest(db: Queryable, caseId: string, requestId: string) {
  return (await db.select().from(documentRequests).where(and(eq(documentRequests.caseId, caseId), eq(documentRequests.requestId, requestId))))[0];
}
export async function findReceipt(db: Queryable, requestId: string) {
  return (await db.select().from(localReceipts).where(eq(localReceipts.requestId, requestId)))[0];
}
