import { and, asc, eq, gt, inArray, max } from 'drizzle-orm';

import type { Queryable } from './client.js';
import { authAccounts, authSessions, authUsers, authVerifications, caseEvents } from './schema.js';

export { authAccounts, authSessions, authUsers, authVerifications };

/** The Better Auth drizzle adapter's model map. */
export const authSchema = { user: authUsers, session: authSessions, account: authAccounts, verification: authVerifications };

export type CaseEventRow = typeof caseEvents.$inferSelect;

/** Durable case events after a sequence cursor, in commit sequence order. */
export async function listCaseEvents(db: Queryable, caseId: string, afterSequence: number, limit: number): Promise<CaseEventRow[]> {
  return db.select().from(caseEvents).where(and(eq(caseEvents.caseId, caseId), gt(caseEvents.sequence, afterSequence))).orderBy(asc(caseEvents.sequence)).limit(limit);
}

/** Most recent event time per case, for queue freshness. */
export async function lastCaseEventTimes(db: Queryable, caseIds: string[]): Promise<Map<string, Date>> {
  if (caseIds.length === 0) return new Map();
  const rows = await db.select({ caseId: caseEvents.caseId, at: max(caseEvents.occurredAt) }).from(caseEvents).where(inArray(caseEvents.caseId, caseIds)).groupBy(caseEvents.caseId);
  return new Map(rows.flatMap((row) => (row.at === null ? [] : [[row.caseId, row.at] as const])));
}
