import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it, vi } from 'vitest';

import { buildApi } from '@pa/api';
import { createCheckpointer, DEFAULT_AGENT_SETTINGS, LiveProviderDisabled, unavailableLiveClient, type AgentSettings } from '@pa/agents';
import type { WorkerConfig } from '@pa/config';
import { loadFixture } from '@pa/connectors';
import { AGENT_QUEUE, DocumentExact, type AgentRunScope, type AgentTraceStep, type CaseSnapshot } from '@pa/contracts';
import { CHECKPOINT_SCHEMA, createDatabase, createRuntimeBoss, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, withConnection, type TestDatabase } from '@pa/db/testing';

import { persistCase } from '../../api/src/cases/service.js';
import { signIn, TEST_ORIGIN } from '../../api/test/support.js';
import { selectProvider, type AgentWorkerDeps } from '../src/agent.js';
import { startWorker, type RunningWorker } from '../src/worker.js';

const TOKEN = 'agent-worker-service-token-0123456789abcdef';
const RECORDING = 'missing-order-investigation';
const core = { appId: 'prior-authorization', dataMode: 'fixture', agentMode: 'rules', authMode: 'fixture', logLevel: 'silent' } as const;
const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, graphProvider: 'recorded' };

let database: TestDatabase;
let apiHandle: DatabaseHandle;
let workerHandle: DatabaseHandle;
let apiBoss: PgBoss;
let services: { api: ReturnType<typeof buildApi>; origin: string; worker: RunningWorker; workerBoss: PgBoss; checkpoints: ReturnType<typeof createCheckpointer> } | undefined;
const liveClientFactory = vi.fn(unavailableLiveClient);
const logs: unknown[] = [];

/** API, worker, queue client and checkpointer, all rebuilt from scratch to stand in for a restart. */
async function startServices() {
  const api = buildApi({ config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'test', authSecret: 'worker-test-auth-secret-0123456789abcdef', publicOrigin: 'http://127.0.0.1:3105', accountingLedgerFile: null, evaluationAdmissionToken: null }, db: apiHandle.db, boss: apiBoss, logger: false, agent: settings });
  const origin = await api.listen({ host: '127.0.0.1', port: 0 });
  const workerBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  const checkpoints = createCheckpointer(database.urls.worker, CHECKPOINT_SCHEMA);
  const config: WorkerConfig = { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null };
  const agent: AgentWorkerDeps = { settings, checkpointer: checkpoints.saver, liveClientFactory };
  const worker = await startWorker({ config, db: workerHandle.db, boss: workerBoss, apiOrigin: origin, workerId: `agent-${randomUUID()}`, agent, log: (message, fields) => logs.push({ message, ...fields }) });
  services = { api, origin, worker, workerBoss, checkpoints };
}
async function stopServices() {
  if (services === undefined) return;
  await services.worker.drain(5_000);
  await services.api.close();
  await services.checkpoints.close();
  services = undefined;
}

beforeAll(async () => {
  database = await createTestDatabase();
  apiHandle = createDatabase(database.urls.api, 'pa-api-agent');
  workerHandle = createDatabase(database.urls.worker, 'pa-worker-agent');
  apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  await startServices();
});
afterAll(async () => {
  await stopServices();
  await apiBoss?.stop({ graceful: false, close: true });
  await apiHandle?.close();
  await workerHandle?.close();
  await database?.drop();
});

const admin = <T>(text: string, values: unknown[] = []) => withConnection(database.urls.admin, async (client) => (await client.query(text, values)).rows as T[]);
const kind = (doc: CaseSnapshot['documents'][number]) => DocumentExact.parse(JSON.parse(doc.metadataText)).kind;

const sessions = new Map<string, string>();
async function request(method: 'GET' | 'POST', path: string, payload?: unknown) {
  const user = /\/agent-runs\/[^/]+\/review$/.test(path) ? 'reviewer' : 'operator';
  if (!sessions.has(user)) sessions.set(user, await signIn(services!.api, user));
  const headers = { origin: TEST_ORIGIN, cookie: sessions.get(user)!, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
  const response = await services!.api.inject({ method, url: path, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

/** F01 with its order and receipt withheld, so R03 reports a missing order. */
async function seedMissingOrder(caseId: string) {
  const full = await loadFixture('F01');
  full.caseText = JSON.stringify({ ...JSON.parse(full.caseText), caseId });
  const missing = { ...full, documents: full.documents.filter((doc) => !['order', 'order_receipt'].includes(kind(doc))) };
  await persistCase(apiHandle.db, apiBoss, missing);
  await expect.poll(async () => ['intake', 'assessing'].includes((await request('GET', `/api/cases/${caseId}`)).body.state as string), { timeout: 15_000, interval: 200 }).toBe(false);
  return full;
}

interface RunView {
  run: { state: string; label: string; stopReason: string | null; failureCode: string | null; modelIdentity: Record<string, unknown> | null; trace: AgentTraceStep[]; outcome: Record<string, unknown> | null };
  proposals: { proposalId: string; kind: string; status: string; code: string | null; review: string; payload: Record<string, unknown> | null }[];
}
async function runView(caseId: string, runId: string) {
  const response = await request('GET', `/api/cases/${caseId}/agent-runs/${runId}`);
  expect(response.status).toBe(200);
  return response.body as unknown as RunView;
}
async function waitForRun(caseId: string, runId: string, state: string) {
  await expect.poll(async () => (await runView(caseId, runId)).run.state, { timeout: 20_000, interval: 200 }).toBe(state);
  return runView(caseId, runId);
}
async function startRun(caseId: string, revision = 1) {
  const response = await request('POST', `/api/cases/${caseId}/agent-runs`, { eventId: randomUUID(), expectedRevision: revision, provider: 'recorded', recordingId: RECORDING });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  return response.body.runId as string;
}
function codes(view: RunView) {
  return view.proposals.map((item) => `${item.kind}:${item.status}:${item.code ?? '-'}`).sort();
}

it('recorded agent smoke: bounded tools, invented citation rejected, human wait, resume after reconstruction against changed evidence, live mode fails closed', async () => {
  const caseId = 'case-agent-smoke';
  const full = await seedMissingOrder(caseId);

  // Requested live mode fails closed with an explicit capability response and no client.
  const live = await request('POST', `/api/cases/${caseId}/agent-runs`, { eventId: randomUUID(), expectedRevision: 1, provider: 'anthropic' });
  expect(live.status).toBe(409);
  expect(live.body).toMatchObject({ error: { code: 'capability_disabled' }, reason: 'live_provider_disabled', capability: { defaultMode: 'rules_only', live: { enabled: false, reason: 'disabled_by_configuration', runBudgetUsd: 0, dailyBudgetUsd: 0, totalBudgetUsd: 0 } } });
  const liveScope: AgentRunScope = {
    runId: randomUUID(), caseId, revision: 1, binding: { expectedRevision: 1, sourceRevisionHash: '0'.repeat(64), policyPackSha256: '0'.repeat(64), packetHash: '0'.repeat(64) },
    threadId: 'unused', phase: 'start', provider: 'anthropic', recordingId: null, versions: { graph: 'g', stateSchema: 's', prompt: 'p', provider: 'anthropic' }, reviewEventId: null,
  };
  await expect(selectProvider(liveScope, { settings, checkpointer: services!.checkpoints.saver, liveClientFactory }, { apiOrigin: 'http://127.0.0.1:9', authorization: 'Bearer unused' }, randomUUID())).rejects.toThrow(LiveProviderDisabled);
  expect((await request('GET', '/api/agent/capability')).body).toMatchObject({ graphProvider: 'recorded', live: { enabled: false } });
  expect((await request('GET', '/api/status')).body).toMatchObject({ modes: { agent: 'rules', agentGraph: 'recorded' } });

  const stateBefore = (await request('GET', `/api/cases/${caseId}`)).body.state;
  const runId = await startRun(caseId);
  const waiting = await waitForRun(caseId, runId, 'awaiting_review');

  // Bounded read and proposal tools, all through the API.
  expect(waiting.run).toMatchObject({ label: 'scripted_fixture', stopReason: 'finished', modelIdentity: { provider: 'recorded', label: 'scripted_fixture', model: 'recorded-synthetic-v1' } });
  expect(waiting.run.trace.map((step) => `${step.kind}:${step.name}:${step.outcome}`)).toEqual([
    'model:recorded:tool_requested', 'tool:list_documents:ok', 'model:recorded:tool_requested', 'tool:read_document:ok',
    'model:recorded:tool_requested', 'tool:get_policy_pack:ok', 'model:recorded:tool_requested', 'tool:propose_facts:ok',
    'model:recorded:tool_requested', 'tool:propose_document_request:ok', 'model:recorded:finish',
  ]);
  // The invented citation (a document version absent from this case) and the low-confidence candidate never become valid.
  expect(codes(waiting)).toEqual(['fact:rejected:low_confidence', 'fact:rejected:source_unavailable', 'fact:valid:-', 'request:valid:-']);
  const valid = waiting.proposals.filter((item) => item.status === 'valid');
  expect(valid.find((item) => item.kind === 'fact')!.payload).toMatchObject({ fact: { field: 'encounter.date', value: '2026-08-20', extractionMethod: 'model', confidence: 0.94, reviewStatus: 'proposed' } });

  // Sanitized trace and logs: hashes and outcomes only, no document text.
  const traceText = JSON.stringify(waiting.run.trace) + JSON.stringify(logs);
  for (const text of ['Avery Testcase', 'Synthetic test text', 'SYNTHETIC TEST DOCUMENT', '2026-08-20']) expect(traceText).not.toContain(text);

  // The human wait holds no queue job, the checkpoint is persisted, and the agent changed no case state.
  const [job] = await admin<{ state: string }>('SELECT state FROM pgboss.job WHERE name = $1 ORDER BY created_on LIMIT 1', [AGENT_QUEUE]);
  expect(job?.state).toBe('completed');
  const [checkpoint] = await admin<{ count: number }>(`SELECT count(*)::int AS count FROM ${CHECKPOINT_SCHEMA}.checkpoints WHERE thread_id = $1`, [`agent-${runId}`]);
  expect(checkpoint!.count).toBeGreaterThan(0);
  expect((await request('GET', `/api/cases/${caseId}`)).body.state).toBe(stateBefore);
  expect((await admin('SELECT * FROM pa_app.document_requests WHERE case_id = $1', [caseId]))).toHaveLength(0);

  // Reconstruct every service while the run waits; the evidence changes meanwhile.
  await stopServices();
  await persistCase(apiHandle.db, apiBoss, { ...full, caseText: JSON.stringify({ ...JSON.parse(full.caseText), revision: 2 }) }, 1);
  await startServices();
  await expect.poll(async () => (await request('GET', `/api/cases/${caseId}`)).body.revision, { timeout: 10_000 }).toBe(2);

  const rejected = waiting.proposals.find((item) => item.status === 'rejected')!;
  expect((await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/review`, { eventId: randomUUID(), decisions: [{ proposalId: rejected.proposalId, decision: 'accept' }] })).status).toBe(409);
  const review = await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/review`, { eventId: randomUUID(), decisions: valid.map((item) => ({ proposalId: item.proposalId, decision: 'accept' })) });
  expect(review.status, JSON.stringify(review.body)).toBe(200);

  const done = await waitForRun(caseId, runId, 'completed');
  expect(done.run.outcome).toMatchObject({ inputsChanged: true, workerReportedInputsChanged: true, accepted: 0, stale: 2, draftedRequests: [] });
  expect(done.proposals.filter((item) => item.status === 'valid').map((item) => item.review)).toEqual(['stale', 'stale']);
  expect((await admin('SELECT * FROM pa_app.document_requests WHERE case_id = $1', [caseId]))).toHaveLength(0);
  expect(liveClientFactory).not.toHaveBeenCalled();
});

it('accepts reviewed proposals against unchanged inputs: a candidate fact compared with the rules, and a draft that still needs approval', async () => {
  const caseId = 'case-agent-unchanged';
  await seedMissingOrder(caseId);
  const stateBefore = (await request('GET', `/api/cases/${caseId}`)).body.state;
  const runId = await startRun(caseId);
  const waiting = await waitForRun(caseId, runId, 'awaiting_review');
  const valid = waiting.proposals.filter((item) => item.status === 'valid');
  expect((await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/review`, { eventId: randomUUID(), decisions: valid.map((item) => ({ proposalId: item.proposalId, decision: 'accept' })) })).status).toBe(200);
  const done = await waitForRun(caseId, runId, 'completed');
  const fact = valid.find((item) => item.kind === 'fact')!;
  expect(done.run.outcome).toMatchObject({ inputsChanged: false, accepted: 2, stale: 0, ruleComparison: [{ proposalId: fact.proposalId, matchesRules: true }] });
  const drafts = await admin<{ state: string; approved_by: string | null; finding_id: string }>('SELECT state, approved_by, finding_id FROM pa_app.document_requests WHERE case_id = $1', [caseId]);
  expect(drafts).toEqual([{ state: 'draft', approved_by: null, finding_id: 'finding-R03' }]);
  expect((await request('GET', `/api/cases/${caseId}`)).body.state).toBe(stateBefore);
});

it('lets the operator cancel a run stranded in flight; later worker reports and reviews are refused', async () => {
  const caseId = 'case-agent-stranded';
  await seedMissingOrder(caseId);
  const runId = await startRun(caseId);
  const waiting = await waitForRun(caseId, runId, 'awaiting_review');
  // Stand in for a lost status report: the run still claims an in-flight job.
  const lostJob = randomUUID();
  await admin("UPDATE pa_app.agent_runs SET state = 'running', pending_job_id = $2 WHERE run_id = $1", [runId, lostJob]);

  const cancel = { eventId: randomUUID() };
  expect((await request('POST', `/api/cases/${caseId}/agent-runs/${randomUUID()}/cancel`, { eventId: randomUUID() })).status).toBe(404);
  const cancelled = await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/cancel`, cancel);
  expect(cancelled).toEqual({ status: 200, body: { runId, state: 'cancelled' } });
  expect(await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/cancel`, cancel)).toEqual(cancelled);
  expect((await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/cancel`, { eventId: randomUUID() })).status).toBe(409);

  const report = await services!.api.inject({ method: 'POST', url: `/internal/worker/v1/agent-runs/${runId}/failure`, headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' }, payload: JSON.stringify({ jobId: lostJob, code: 'agent_error' }) });
  expect(report.statusCode).toBe(409);
  const valid = waiting.proposals.filter((item) => item.status === 'valid');
  expect((await request('POST', `/api/cases/${caseId}/agent-runs/${runId}/review`, { eventId: randomUUID(), decisions: valid.map((item) => ({ proposalId: item.proposalId, decision: 'accept' })) })).status).toBe(409);
  expect((await runView(caseId, runId)).run.state).toBe('cancelled');
  // A fresh run on the same case is still possible.
  await waitForRun(caseId, await startRun(caseId), 'awaiting_review');
});
