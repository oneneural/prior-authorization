import { afterAll, beforeAll, expect, it } from 'vitest';

import { loadFixture } from '@pa/connectors';
import { AssessmentOutcomeV3, CASE_QUEUE, CASE_WORKER_PATH, CasePacket, DocumentExact } from '@pa/contracts';
import { createDatabase, type DatabaseHandle } from '@pa/db';

import { startWorker, type RunningWorker } from '../../worker/src/worker.js';
import { buildApi } from '../src/app.js';
import { seedCases } from '../src/cases/seed.js';
import { persistCase, recordCaseResult } from '../src/cases/service.js';
import { kindMismatchCase } from './case-fixtures.js';
import { adminQuery, startApiHarness, testApiConfig, TEST_TOKEN, type ApiHarness } from './support.js';

let harness: ApiHarness;
let workerDb: DatabaseHandle;
let worker: RunningWorker;
beforeAll(async () => { harness = await startApiHarness(); });
afterAll(async () => {
  await worker?.drain(5_000);
  await workerDb?.close();
  await harness?.close();
});

it('case packet smoke: persists, assesses, reconstructs, cites and exports without cross-case access', async () => {
  const seeded = await seedCases(harness.handle.db, harness.apiBoss);
  expect(seeded.filter((row) => row.created)).toHaveLength(5);
  expect((await harness.inject('/api/cases/case-f01')).json()).toMatchObject({ state: 'assessing', revision: 1 });
  const jobId = seeded.find((row) => row.caseId === 'case-f01')!.jobId!;
  expect((await harness.inject(`${CASE_WORKER_PATH}/${jobId}`)).statusCode).toBe(401);
  expect((await harness.inject({ url: `${CASE_WORKER_PATH}/${jobId}`, headers: { authorization: `Bearer ${TEST_TOKEN}` } })).statusCode).toBe(409);

  const origin = await harness.app.listen({ host: '127.0.0.1', port: 0 });
  workerDb = createDatabase(harness.database.urls.worker, 'pa-case-smoke-worker');
  worker = await startWorker({
    config: { ...testApiConfig(harness.database.urls.worker), concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null },
    db: workerDb.db, boss: harness.workerBoss, apiOrigin: origin, workerId: 'case-smoke-worker',
  });
  for (const row of seeded) {
    await expect.poll(async () => (await harness.inject(`/api/cases/${row.caseId}`)).json<{ state: string }>().state, { timeout: 15_000, interval: 100 }).not.toBe('assessing');
  }
  await expect.poll(async () => (await harness.apiBoss.getJobById(CASE_QUEUE, jobId))?.state, { timeout: 5_000 }).toBe('completed');
  const assessed = (await harness.inject('/api/cases/case-f01')).json<{ state: string; assessment: unknown }>();
  const originalOutcome = AssessmentOutcomeV3.parse(assessed.assessment);
  expect(assessed).toMatchObject({ state: 'ready_for_review', assessment: { outcome: 'assessed' } });
  const packet = CasePacket.parse((await harness.inject('/api/cases/case-f01/packet')).json());
  expect(packet.clinicalReviewStatus).toBe('requires_qualified_review');
  expect(packet.notice).toContain('No payer submission');
  expect((await harness.inject('/api/cases/case-f01/policy')).json<{ policyPackSha256: string }>().policyPackSha256).toBe(packet.policyPackSha256);
  expect((await harness.inject('/api/cases/case-f01/documents')).json<{ documents: unknown[] }>().documents).toHaveLength(4);
  const quarantineCase = await loadFixture('F08a');
  const foreign = quarantineCase.documents.map((doc) => DocumentExact.parse(JSON.parse(doc.metadataText))).find((meta) => meta.documentId === 'f08a-attachment')!;
  expect((await harness.inject(`/api/cases/case-f08a/documents/${foreign.documentId}/versions/${foreign.version}`)).statusCode).toBe(404);
  const fact = packet.evidenceFacts[0]!;
  const citePath = `/api/cases/case-f01/documents/${fact.documentId}/versions/${fact.documentVersion}?locator=${encodeURIComponent(fact.locator)}`;
  const source = await harness.inject(citePath);
  expect(source.statusCode).toBe(200);
  expect(source.json()).toMatchObject({ originalText: fact.originalText, contentHash: packet.documents.find((doc) => doc.metadata.documentId === fact.documentId)!.metadata.contentHash });
  expect((await harness.inject(`/api/cases/case-f23/documents/${fact.documentId}/versions/${fact.documentVersion}`)).statusCode).toBe(404);
  expect((await harness.inject({ method: 'POST', url: '/api/cases/case-f01/assess', payload: { expectedRevision: 1, actorId: 'other' } })).statusCode).toBe(400);
  expect((await harness.inject({ method: 'POST', url: '/api/cases/case-f01/assess', payload: { expectedRevision: 2 } })).statusCode).toBe(409);
  const quarantinedPacket = CasePacket.parse((await harness.inject('/api/cases/case-f08a/packet')).json());
  expect(quarantinedPacket.documents.some((doc) => doc.metadata.documentId === foreign.documentId)).toBe(false);
  const irrelevantPacket = CasePacket.parse((await harness.inject('/api/cases/case-f28a/packet')).json());
  expect(irrelevantPacket.documents.every((doc) => doc.metadata.kind !== 'supporting_note')).toBe(true);

  const mismatch = await persistCase(harness.handle.db, harness.apiBoss, await kindMismatchCase());
  await expect.poll(async () => (await harness.inject(`/api/cases/${mismatch.caseId}`)).json<{ state: string }>().state, { timeout: 15_000, interval: 100 }).not.toBe('assessing');
  const mismatchCase = (await harness.inject(`/api/cases/${mismatch.caseId}`)).json<{ assessment: unknown }>();
  const mismatchOutcome = AssessmentOutcomeV3.parse(mismatchCase.assessment);
  if (mismatchOutcome.outcome !== 'assessed') throw new Error('unexpected rejection');
  expect(mismatchOutcome.result.quarantinedDocuments).toEqual([]);
  const mismatchResponse = await harness.inject(`/api/cases/${mismatch.caseId}/packet`);
  expect(mismatchResponse.statusCode).toBe(200);
  const mismatchPacket = CasePacket.parse(mismatchResponse.json());
  expect(mismatchPacket.findings.find((finding) => finding.ruleId === 'R09')?.conditions).toContainEqual({ conditionKey: 'R09.kind_mismatch', field: null, documentRefs: [{ documentId: 'f01-order', version: 1 }] });
  expect(mismatchPacket.includedDocumentRefs).not.toContainEqual({ documentId: 'f01-order', version: 1 });
  expect(mismatchPacket.documents.some((doc) => doc.metadata.documentId === 'f01-order')).toBe(false);
  expect(mismatchPacket.evidenceFacts.some((fact) => fact.documentId === 'f01-order')).toBe(false);
  expect(mismatchResponse.body).not.toMatch(/SYN-OTHER|Other Synthetic Person/);
  const mismatchMetadata = await harness.inject(`/api/cases/${mismatch.caseId}/documents`);
  expect(mismatchMetadata.statusCode).toBe(200);
  expect(mismatchMetadata.json<{ documents: unknown[] }>().documents).toContainEqual(expect.objectContaining({ documentId: 'f01-order', version: 1, kind: 'order' }));
  for (const query of ['', '?locator=%2Fbeneficiary%2Fidentifier']) {
    const deniedSource = await harness.inject(`/api/cases/${mismatch.caseId}/documents/f01-order/versions/1${query}`);
    expect(deniedSource.statusCode).toBe(404);
    expect(deniedSource.body).not.toMatch(/SYN-OTHER|Other Synthetic Person/);
  }

  await worker.drain(5_000);
  await harness.app.close();
  harness.app = buildApi({ config: testApiConfig(harness.database.urls.api), db: harness.handle.db, boss: harness.apiBoss, logger: false });
  await harness.app.ready();
  expect(CasePacket.parse((await harness.inject('/api/cases/case-f01/packet')).json()).packetHash).toBe(packet.packetHash);
  expect((await harness.inject(citePath)).json()).toEqual(source.json());
  const before = await adminQuery(harness.database, 'SELECT * FROM pa_app.case_events ORDER BY sequence');
  expect((await seedCases(harness.handle.db, harness.apiBoss)).every((row) => !row.created)).toBe(true);
  expect(await adminQuery(harness.database, 'SELECT * FROM pa_app.case_events ORDER BY sequence')).toEqual(before);
  const blobs = await adminQuery<{ count: number }>(harness.database, 'SELECT count(*)::int AS count FROM pa_app.case_blobs');
  const refs = await adminQuery<{ count: number }>(harness.database, 'SELECT count(*)::int AS count FROM pa_app.case_documents WHERE blob_hash IS NOT NULL');
  expect(blobs[0]!.count).toBeLessThan(refs[0]!.count + 1);

  // An owner assigned by server storage cannot be overridden by caller headers.
  await adminQuery(harness.database, "UPDATE pa_app.cases SET owner_id = 'other-fixture-operator' WHERE case_id = 'case-f23'");
  expect((await harness.inject({ url: '/api/cases/case-f23', headers: { 'x-actor-id': 'other-fixture-operator' } })).statusCode).toBe(404);

  await adminQuery(harness.database, "UPDATE pa_app.cases SET owner_id = 'fixture-operator' WHERE case_id = 'case-f23'");

  // A new trusted revision preserves source identities and invalidates the old packet immediately.
  const next = await loadFixture('F01');
  const record = JSON.parse(next.caseText) as { revision: number };
  record.revision = 2;
  next.caseText = JSON.stringify(record);
  const doc = next.documents[0]!;
  const meta = DocumentExact.parse(JSON.parse(doc.metadataText));
  next.documents.push({ ...doc, slot: `${doc.slot}-copy`, metadataText: JSON.stringify({ ...meta, version: 2, supersedes: { documentId: meta.documentId, version: 1 } }) });
  await persistCase(harness.handle.db, harness.apiBoss, next, 1);
  expect((await harness.inject('/api/cases/case-f01/packet')).statusCode).toBe(409);
  expect((await seedCases(harness.handle.db, harness.apiBoss)).find((row) => row.caseId === 'case-f01')!.created).toBe(false);
  await expect(recordCaseResult(harness.handle.db, harness.apiBoss, jobId, { caseId: 'case-f01', revision: 1, outcome: originalOutcome })).rejects.toThrow('no longer current');
  process.stdout.write(`case packet smoke: 5 seeded cases and R09 kind-mismatch regression assessed, restart digest ${packet.packetHash}, exact citation read, repeat seed preserved events, cross-case denied, stale revision denied\n`);
});
