import { FIXTURE_IDS, loadFixture } from '@pa/connectors';
import { DocumentExact, type CaseSnapshot } from '@pa/contracts';
import type { Database, PgBoss } from '@pa/db';

import { persistCase } from './service.js';

/** Non-destructive and idempotent. Repeated runs preserve revisions, packets and events. */
export async function seedCases(db: Database, boss: PgBoss) {
  const results = [];
  for (const id of FIXTURE_IDS) results.push(await persistCase(db, boss, await loadFixture(id)));
  return results;
}

/**
 * The SPEC F02 missing-order scenario on F01's synthetic subject: F01 with its
 * order and receipt withheld, so the archived F01 order can answer the request.
 * The stored fixture bytes are unchanged; only the case ID differs.
 */
export async function missingOrderCase(caseId: string): Promise<CaseSnapshot> {
  const full = await loadFixture('F01');
  full.caseText = JSON.stringify({ ...JSON.parse(full.caseText), caseId });
  return { ...full, documents: full.documents.filter((doc) => !['order', 'order_receipt'].includes(DocumentExact.parse(JSON.parse(doc.metadataText)).kind)) };
}

/** The request loop case and the recorded agent case beside the five fixture cases. */
export const DERIVED_DEMO_CASES = ['case-f02-loop', 'case-agent-demo'] as const;

/**
 * The populated demonstration queue, seeded when the API starts in fixture
 * data mode. Idempotent like `seedCases`: an existing case keeps its history.
 */
export async function seedDemoCases(db: Database, boss: PgBoss) {
  const results = await seedCases(db, boss);
  for (const caseId of DERIVED_DEMO_CASES) results.push(await persistCase(db, boss, await missingOrderCase(caseId)));
  return results;
}
