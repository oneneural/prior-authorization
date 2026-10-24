import { desc, eq } from 'drizzle-orm';

import type { Queryable, Transaction } from './client.js';
import { agentProposals, agentRuns } from './schema.js';

export { agentProposals, agentRuns };
export type AgentRunRow = typeof agentRuns.$inferSelect;
export type AgentProposalRow = typeof agentProposals.$inferSelect;

export async function findAgentRun(db: Queryable, runId: string): Promise<AgentRunRow | undefined> {
  return (await db.select().from(agentRuns).where(eq(agentRuns.runId, runId)))[0];
}
export async function lockAgentRun(tx: Transaction, runId: string): Promise<AgentRunRow | undefined> {
  return (await tx.select().from(agentRuns).where(eq(agentRuns.runId, runId)).for('update'))[0];
}
export async function listAgentProposals(db: Queryable, runId: string): Promise<AgentProposalRow[]> {
  return db.select().from(agentProposals).where(eq(agentProposals.runId, runId)).orderBy(agentProposals.createdAt, agentProposals.proposalKey);
}
export async function listCaseAgentRuns(db: Queryable, caseId: string): Promise<AgentRunRow[]> {
  return db.select().from(agentRuns).where(eq(agentRuns.caseId, caseId)).orderBy(desc(agentRuns.createdAt));
}
