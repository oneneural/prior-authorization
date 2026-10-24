import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildApi } from '@pa/api';
import { attemptCeilingUnits, createCheckpointer, DEFAULT_AGENT_SETTINGS, OPUS_5_5_TARIFF, sdkLiveClient, type AgentSettings, type LiveClientFactory, type LiveModelClient } from '@pa/agents';
import type { WorkerConfig } from '@pa/config';
import { loadFixture } from '@pa/connectors';
import { AGENT_QUEUE, DocumentExact, EVALUATION_ADMISSION_PATH, type CaseSnapshot } from '@pa/contracts';
import { CHECKPOINT_SCHEMA, createDatabase, createRuntimeBoss, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, withConnection, type TestDatabase } from '@pa/db/testing';

import { migrateLedger } from '../../api/src/accounting/migrate.js';
import { LiveAdmission } from '../../api/src/accounting/service.js';
import { stopInterruptedLiveRuns } from '../../api/src/agent/service.js';
import { persistCase } from '../../api/src/cases/service.js';
import { signIn, TEST_ORIGIN } from '../../api/test/support.js';
import { startWorker, type RunningWorker } from '../src/worker.js';

// Packaged live mode through the real API, admission routes, ledger, worker,
// graph and checkpointer, with a fake Messages client and disposable ledger
// files (ADR 0001 offline checks). No key, network or model is used.

const TOKEN = 'agent-live-worker-token-0123456789abcdef';
const EVAL_TOKEN = 'agent-live-evaluation-token-0123456789abcdef';
const CEILING = attemptCeilingUnits(OPUS_5_5_TARIFF, 8192);
const USAGE = { input_tokens: 1500, output_tokens: 200, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, service_tier: 'standard' };
const PER_CALL_UNITS = 1500 * 40 + 200 * 200;
const core = { appId: 'prior-authorization', dataMode: 'fixture', agentMode: 'rules', authMode: 'fixture', logLevel: 'silent' } as const;
const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, graphProvider: 'live', live: { runUnits: 100_000_000, dayUnits: 200_000_000, totalUnits: 200_000_000 } };

let database: TestDatabase;
let apiHandle: DatabaseHandle;
let workerHandle: DatabaseHandle;
let apiBoss: PgBoss;

const ledgerDirs: string[] = [];

interface Harness { api: ReturnType<typeof buildApi>; origin: string; worker: RunningWorker; checkpoints: ReturnType<typeof createCheckpointer>; admission: LiveAdmission; sessions: Map<string, string>; proxy: Server | null }

/**
 * A pass-through proxy between the worker and the API that forwards the first
 * job claim and then drops its response, as a lost acknowledgement would.
 */
async function lossyClaimProxy(origin: string, claims: string[]) {
  let dropped = false;
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const body = chunks.length === 0 ? undefined : Buffer.concat(chunks).toString('utf8');
      const isClaim = (req.url ?? '').endsWith('/claim');
      if (isClaim && body !== undefined) claims.push((JSON.parse(body) as { claimId: string }).claimId);
      const headers = Object.fromEntries(Object.entries(req.headers).filter(([name]) => ['authorization', 'content-type'].includes(name))) as Record<string, string>;
      void fetch(new URL(req.url ?? '/', origin), { method: req.method, headers, body }).then(async (response) => {
        const text = await response.text();
        if (isClaim && !dropped) {
          dropped = true;
          req.socket.destroy();
          return;
        }
        res.writeHead(response.status, { 'content-type': response.headers.get('content-type') ?? 'application/json' }).end(text);
      });
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address() as { port: number };
  return { server, origin: `http://127.0.0.1:${address.port}` };
}
const running = new Set<Harness>();

/** API (with its own ledger writer) and worker, rebuilt from scratch to stand in for a container restart. */
async function startHarness(ledgerPath: string | null, liveClientFactory: LiveClientFactory, options: { sweep?: boolean; agent?: AgentSettings; claims?: string[] } = {}): Promise<Harness> {
  const agent = options.agent ?? settings;
  const admission = await LiveAdmission.start(agent, ledgerPath, 'test');
  // As in the API's main: live runs left `running` by a previous process stop before the API serves.
  if (options.sweep === true) await stopInterruptedLiveRuns(apiHandle.db, admission);
  const api = buildApi({
    config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'test', authSecret: 'worker-test-auth-secret-0123456789abcdef', publicOrigin: 'http://127.0.0.1:3105', accountingLedgerFile: ledgerPath, evaluationAdmissionToken: EVAL_TOKEN },
    db: apiHandle.db, boss: apiBoss, logger: false, agent, admission,
  });
  const origin = await api.listen({ host: '127.0.0.1', port: 0 });
  const workerBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  const checkpoints = createCheckpointer(database.urls.worker, CHECKPOINT_SCHEMA);
  const config: WorkerConfig = { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null };
  const proxy = options.claims === undefined ? null : await lossyClaimProxy(origin, options.claims);
  const worker = await startWorker({ config, db: workerHandle.db, boss: workerBoss, apiOrigin: proxy?.origin ?? origin, workerId: `live-${randomUUID()}`, agent: { settings: agent, checkpointer: checkpoints.saver, liveClientFactory } });
  const harness = { api, origin, worker, checkpoints, admission, sessions: new Map<string, string>(), proxy: proxy?.server ?? null };
  running.add(harness);
  return harness;
}
async function stopHarness(harness: Harness, drainMs = 5_000) {
  running.delete(harness);
  await harness.worker.drain(drainMs);
  await harness.api.close();
  await harness.checkpoints.close();
  harness.proxy?.closeAllConnections();
  await new Promise((resolve) => harness.proxy === null ? resolve(undefined) : harness.proxy.close(resolve));
  // A graceful stop releases the account writer lock.
  await harness.admission.close();
}

beforeAll(async () => {
  database = await createTestDatabase();
  apiHandle = createDatabase(database.urls.api, 'pa-api-live');
  workerHandle = createDatabase(database.urls.worker, 'pa-worker-live');
  apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
});
afterAll(async () => {
  for (const harness of [...running]) await stopHarness(harness, 500).catch(() => undefined);
  await apiBoss?.stop({ graceful: false, close: true });
  await apiHandle?.close();
  await workerHandle?.close();
  await database?.drop();
  await Promise.all(ledgerDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A canonical ledger migrated from a synthetic v1 file holding one earlier reconciled call. */
async function freshLedger() {
  const dir = await mkdtemp(join(tmpdir(), 'pa-live-ledger-'));
  ledgerDirs.push(dir);
  const path = join(dir, 'ledger.json');
  const entry = {
    reservationId: randomUUID(), runId: 'earlier', day: '2026-10-21', createdAt: '2026-10-21T10:00:00.000Z', model: 'claude-opus-5-5', reservedUsd: 5.16384,
    actualUsd: 0.0204, usage: { inputTokens: 1100, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, status: 'reconciled',
  };
  await writeFile(path, JSON.stringify({ schemaVersion: 'pa.anthropic-spend.v1', committedUsd: 0.0204, entries: [entry] }));
  await copyFile(path, join(dir, 'retained.json'));
  await migrateLedger({ ledgerPath: path, sourceCopy: join(dir, 'retained.json') });
  return path;
}

const admin = <T>(text: string, values: unknown[] = []) => withConnection(database.urls.admin, async (client) => (await client.query(text, values)).rows as T[]);
const kind = (doc: CaseSnapshot['documents'][number]) => DocumentExact.parse(JSON.parse(doc.metadataText)).kind;

async function request(harness: Harness, method: 'GET' | 'POST', path: string, payload?: unknown) {
  const user = /\/agent-runs\/[^/]+\/review$/.test(path) ? 'reviewer' : 'operator';
  if (!harness.sessions.has(user)) harness.sessions.set(user, await signIn(harness.api, user));
  const headers = { origin: TEST_ORIGIN, cookie: harness.sessions.get(user)!, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) };
  const response = await harness.api.inject({ method, url: path, headers, ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}
async function internal(harness: Harness, path: string, payload: unknown, token = TOKEN) {
  const response = await harness.api.inject({ method: 'POST', url: path, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, payload: JSON.stringify(payload) });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

/** F01 with its order and receipt withheld. */
async function seedCase(harness: Harness, caseId: string) {
  const full = await loadFixture('F01');
  full.caseText = JSON.stringify({ ...JSON.parse(full.caseText), caseId });
  await persistCase(apiHandle.db, apiBoss, { ...full, documents: full.documents.filter((doc) => !['order', 'order_receipt'].includes(kind(doc))) });
  await expect.poll(async () => ['intake', 'assessing'].includes((await request(harness, 'GET', `/api/cases/${caseId}`)).body.state as string), { timeout: 15_000, interval: 200 }).toBe(false);
  return full;
}

interface RunView { run: { state: string; label: string; stopReason: string | null; failureCode: string | null; modelIdentity: Record<string, unknown> | null } }
async function runView(harness: Harness, caseId: string, runId: string) {
  return (await request(harness, 'GET', `/api/cases/${caseId}/agent-runs/${runId}`)).body as unknown as RunView;
}
async function waitForRun(harness: Harness, caseId: string, runId: string, state: string) {
  await expect.poll(async () => (await runView(harness, caseId, runId)).run.state, { timeout: 20_000, interval: 200 }).toBe(state);
  return runView(harness, caseId, runId);
}
async function startLiveRun(harness: Harness, caseId: string, revision = 1) {
  const response = await request(harness, 'POST', `/api/cases/${caseId}/agent-runs`, { eventId: randomUUID(), expectedRevision: revision, provider: 'anthropic' });
  expect(response.status, JSON.stringify(response.body)).toBe(202);
  expect(response.body.label).toBe('live_claude');
  return response.body.runId as string;
}

type Message = Awaited<ReturnType<LiveModelClient['create']>>;
function reply(stop_reason: Message['stop_reason'], content: unknown[]): Message {
  return { id: `msg_${randomUUID().replaceAll('-', '')}`, type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, stop_details: null, usage: USAGE } as unknown as Message;
}

/** Lists documents, then finishes. `beforeReply` runs inside each request, after it was sent and before its response. */
function scriptedClient(beforeReply: (turn: number) => Promise<void> | void = () => undefined) {
  const sent: number[] = [];
  const client: LiveModelClient = {
    async create(params) {
      const turn = params.messages.filter((message) => message.role === 'assistant').length;
      sent.push(turn);
      await beforeReply(turn);
      return turn === 0 ? reply('tool_use', [{ type: 'tool_use', id: 'toolu_list', name: 'list_documents', input: {} }]) : reply('end_turn', [{ type: 'text', text: 'done' }]);
    },
  };
  return { factory: vi.fn(() => client), sent };
}

function gate() {
  let open: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => { open = resolve; });
  return { opened, open: () => open() };
}

const ledgerRun = (harness: Harness, runId: string) => {
  const state = harness.admission.settlementLedger().snapshot();
  return { run: state.runs.find((item) => item.runId === runId), attempts: state.attempts.filter((item) => item.runId === runId) };
};

describe('packaged live mode', () => {
  it('admits every attempt through the canonical ledger, then resumes review with zero SDK construction', async () => {
    const ledgerPath = await freshLedger();
    const client = scriptedClient();
    let harness = await startHarness(ledgerPath, client.factory);
    const caseId = 'case-live-review';
    await seedCase(harness, caseId);
    expect((await request(harness, 'GET', '/api/agent/capability')).body).toMatchObject({ graphProvider: 'live', live: { enabled: true, reason: 'available', runBudgetUsd: 10, attemptReservationUsd: 5.16384 } });
    expect((await request(harness, 'GET', '/api/status')).body).toMatchObject({ modes: { agentGraph: 'live' } });
    const runId = await startLiveRun(harness, caseId);
    const waiting = await waitForRun(harness, caseId, runId, 'awaiting_review');
    expect(waiting.run).toMatchObject({ label: 'live_claude', stopReason: 'finished', modelIdentity: { provider: 'anthropic', label: 'live_claude', model: 'claude-opus-5-5' } });
    expect(client.factory).toHaveBeenCalledTimes(1);
    expect(client.sent).toEqual([0, 1]);
    const { run, attempts } = ledgerRun(harness, runId);
    expect(run).toMatchObject({ callerKind: 'packaged', capUnits: 100_000_000, state: 'stopped', stopReason: 'awaiting_review', binding: { caseId } });
    expect(attempts.map((item) => [item.turn, item.state, item.actualUnits, item.owner?.kind])).toEqual([[0, 'reconciled', PER_CALL_UNITS, 'worker'], [1, 'reconciled', PER_CALL_UNITS, 'worker']]);
    expect(harness.admission.settlementLedger().status().lifetimeCommittedUnits).toBe(204_000 + 2 * PER_CALL_UNITS);

    // Restart every service while the run waits for a person, then resume it.
    await stopHarness(harness);
    const resumeFactory = vi.fn<LiveClientFactory>(() => { throw new Error('a resumed live run must not construct a client'); });
    harness = await startHarness(ledgerPath, resumeFactory);
    const ledgerBefore = await readFile(ledgerPath, 'utf8');
    const review = await request(harness, 'POST', `/api/cases/${caseId}/agent-runs/${runId}/review`, { eventId: randomUUID(), decisions: [] });
    expect(review.status, JSON.stringify(review.body)).toBe(200);
    await waitForRun(harness, caseId, runId, 'completed');
    expect(resumeFactory).not.toHaveBeenCalled();
    expect(client.sent).toEqual([0, 1]);
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBefore);

    // An older database snapshot of the run (queued, no proposals, no checkpoint) is restored and its job redelivered.
    const restoredJob = randomUUID();
    await admin("UPDATE pa_app.agent_runs SET state = 'queued', pending_job_id = $2, stop_reason = NULL, model_identity = NULL, trace = '[]', outcome = NULL WHERE run_id = $1", [runId, restoredJob]);
    for (const table of ['checkpoint_writes', 'checkpoint_blobs', 'checkpoints']) await admin(`DELETE FROM ${CHECKPOINT_SCHEMA}.${table} WHERE thread_id = $1`, [`agent-${runId}`]);
    await stopHarness(harness);
    const restoredClient = scriptedClient();
    harness = await startHarness(ledgerPath, restoredClient.factory);
    const ledgerAtRestore = await readFile(ledgerPath, 'utf8');
    await apiBoss.send(AGENT_QUEUE, { runId, phase: 'start' }, { id: restoredJob, retryLimit: 0 });
    const failed = await waitForRun(harness, caseId, runId, 'failed');
    // The recorded attempt identity cannot be granted again, so nothing is sent and accounting is unchanged.
    expect(failed.run.failureCode).toBe('admission_unavailable');
    expect(restoredClient.sent).toEqual([]);
    expect(ledgerRun(harness, runId).attempts).toHaveLength(2);
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerAtRestore);
    await stopHarness(harness);
  });

  it('refuses the next attempt when inputs go stale, and stops a cancelled run while settling its late response', async () => {
    const ledgerPath = await freshLedger();
    const seeded: { full?: Awaited<ReturnType<typeof seedCase>> } = {};
    const staleClient = scriptedClient(async (turn) => {
      const full = seeded.full!;
      if (turn === 0) await persistCase(apiHandle.db, apiBoss, { ...full, caseText: JSON.stringify({ ...JSON.parse(full.caseText) as object, revision: 2 }) }, 1);
    });
    let harness = await startHarness(ledgerPath, staleClient.factory);
    seeded.full = await seedCase(harness, 'case-live-stale');
    const staleRun = await startLiveRun(harness, 'case-live-stale');
    expect((await waitForRun(harness, 'case-live-stale', staleRun, 'failed')).run.failureCode).toBe('admission_unavailable');
    expect(staleClient.sent).toEqual([0]);
    expect(ledgerRun(harness, staleRun)).toMatchObject({ run: { state: 'stopped', stopReason: 'binding_stale' }, attempts: [{ turn: 0, state: 'reconciled' }] });
    await stopHarness(harness);

    const held = gate();
    const cancelClient = scriptedClient(async (turn) => { if (turn === 0) await held.opened; });
    harness = await startHarness(ledgerPath, cancelClient.factory);
    await seedCase(harness, 'case-live-cancel');
    const cancelRun = await startLiveRun(harness, 'case-live-cancel');
    await expect.poll(() => cancelClient.sent.length, { timeout: 15_000 }).toBe(1);
    expect((await request(harness, 'POST', `/api/cases/case-live-cancel/agent-runs/${cancelRun}/cancel`, { eventId: randomUUID() })).status).toBe(200);
    held.open();
    // The late usage reconciles the attempt; the cancelled run never gets another grant.
    await expect.poll(() => ledgerRun(harness, cancelRun).attempts.map((item) => item.state), { timeout: 15_000 }).toEqual(['reconciled']);
    expect(ledgerRun(harness, cancelRun).run).toMatchObject({ state: 'stopped', stopReason: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(cancelClient.sent).toEqual([0]);
    expect((await runView(harness, 'case-live-cancel', cancelRun)).run.state).toBe('cancelled');
    await stopHarness(harness);
  });

  it('retries a claim whose response was lost with the same claim, and the live run continues', async () => {
    const ledgerPath = await freshLedger();
    const client = scriptedClient();
    const claims: string[] = [];
    const harness = await startHarness(ledgerPath, client.factory, { claims });
    await seedCase(harness, 'case-live-lost-claim');
    const runId = await startLiveRun(harness, 'case-live-lost-claim');
    const waiting = await waitForRun(harness, 'case-live-lost-claim', runId, 'awaiting_review');
    expect(waiting.run.failureCode).toBeNull();
    expect(claims).toHaveLength(2);
    expect(new Set(claims).size).toBe(1);
    expect(client.sent).toEqual([0, 1]);
    expect(ledgerRun(harness, runId).attempts.map((item) => item.state)).toEqual(['reconciled', 'reconciled']);
    await stopHarness(harness);
  });

  it('stops an interrupted investigation safely instead of reconstructing its conversation', async () => {
    const ledgerPath = await freshLedger();
    // A second claim of the same active job, as after a redelivery: the API stops the run before review.
    const held = gate();
    const client = scriptedClient(async (turn) => { if (turn === 0) await held.opened; });
    let harness = await startHarness(ledgerPath, client.factory);
    await seedCase(harness, 'case-live-reclaim');
    const runId = await startLiveRun(harness, 'case-live-reclaim');
    await expect.poll(() => client.sent.length, { timeout: 15_000 }).toBe(1);
    const [row] = await admin<{ pending_job_id: string; claim_id: string }>('SELECT pending_job_id, claim_id FROM pa_app.agent_runs WHERE run_id = $1', [runId]);
    const claimPath = `/internal/worker/v1/agent-runs/${runId}/jobs/${row!.pending_job_id}/claim`;
    // The worker's own claim repeated is a retry: the healthy run keeps running.
    expect(await internal(harness, claimPath, { claimId: row!.claim_id })).toMatchObject({ status: 200, body: { runId, phase: 'start' } });
    expect((await runView(harness, 'case-live-reclaim', runId)).run.state).toBe('running');
    const reclaim = await internal(harness, claimPath, { claimId: randomUUID() });
    expect(reclaim.status).toBe(409);
    expect((await runView(harness, 'case-live-reclaim', runId)).run).toMatchObject({ state: 'failed', failureCode: 'interrupted_before_review' });
    held.open();
    await expect.poll(() => ledgerRun(harness, runId).attempts.map((item) => item.state), { timeout: 15_000 }).toEqual(['reconciled']);
    expect(ledgerRun(harness, runId).run).toMatchObject({ state: 'stopped', stopReason: 'interrupted_before_review' });
    expect(client.sent).toEqual([0]);
    await stopHarness(harness);

    // A crash with a request in flight: the restarted API stops the run and the full reservation stays held.
    const stuck = gate();
    const crashing = scriptedClient(async (turn) => { if (turn === 0) await stuck.opened; });
    harness = await startHarness(ledgerPath, crashing.factory);
    await seedCase(harness, 'case-live-crash');
    const crashRun = await startLiveRun(harness, 'case-live-crash');
    await expect.poll(() => crashing.sent.length, { timeout: 15_000 }).toBe(1);
    await stopHarness(harness, 300);
    const restartFactory = vi.fn<LiveClientFactory>(() => { throw new Error('unexpected client'); });
    harness = await startHarness(ledgerPath, restartFactory, { sweep: true });
    expect((await runView(harness, 'case-live-crash', crashRun)).run).toMatchObject({ state: 'failed', failureCode: 'interrupted_before_review' });
    expect(ledgerRun(harness, crashRun).attempts.map((item) => [item.state, item.reservedUnits])).toEqual([['dispatching', CEILING]]);
    expect(harness.admission.settlementLedger().status()).toMatchObject({ activeDispatches: 1 });
    stuck.open();
    expect(restartFactory).not.toHaveBeenCalled();
    expect(crashing.sent).toEqual([0]);
    await stopHarness(harness);
  });

  it('refuses live work before any request without a usable key or ledger, and shares one dispatch slot with the evaluation caller', async () => {
    const ledgerPath = await freshLedger();
    let harness = await startHarness(ledgerPath, sdkLiveClient(join(tmpdir(), `missing-${randomUUID()}`)));
    await seedCase(harness, 'case-live-nokey');
    const noKey = await startLiveRun(harness, 'case-live-nokey');
    expect((await waitForRun(harness, 'case-live-nokey', noKey, 'failed')).run.failureCode).toBe('live_provider_unavailable');
    expect(ledgerRun(harness, noKey).attempts).toEqual([]);
    await stopHarness(harness);

    for (const path of [null, join(tmpdir(), `absent-${randomUUID()}.json`)]) {
      harness = await startHarness(path, vi.fn<LiveClientFactory>());
      expect((await request(harness, 'GET', '/api/agent/capability')).body).toMatchObject({ live: { enabled: false, reason: 'accounting_unavailable' } });
      const refused = await request(harness, 'POST', '/api/cases/case-live-nokey/agent-runs', { eventId: randomUUID(), expectedRevision: 1, provider: 'anthropic' });
      expect(refused).toMatchObject({ status: 409, body: { reason: 'accounting_unavailable' } });
      await stopHarness(harness);
    }

    // A run cap below one full reservation could never admit an attempt: reported and refused, ledger untouched.
    const ledgerBytes = await readFile(ledgerPath, 'utf8');
    harness = await startHarness(ledgerPath, vi.fn<LiveClientFactory>(), { agent: { ...settings, live: { ...settings.live, runUnits: 50_000_000 } } });
    expect((await request(harness, 'GET', '/api/agent/capability')).body).toMatchObject({ live: { enabled: false, reason: 'cap_below_attempt_ceiling', runBudgetUsd: 5 } });
    const tooSmall = await request(harness, 'POST', '/api/cases/case-live-nokey/agent-runs', { eventId: randomUUID(), expectedRevision: 1, provider: 'anthropic' });
    expect(tooSmall).toMatchObject({ status: 409, body: { reason: 'cap_below_attempt_ceiling' } });
    await stopHarness(harness);
    expect(await readFile(ledgerPath, 'utf8')).toBe(ledgerBytes);

    const client = scriptedClient();
    harness = await startHarness(ledgerPath, client.factory);
    await seedCase(harness, 'case-live-busy');
    const base = `${EVALUATION_ADMISSION_PATH}/runs`;
    expect((await internal(harness, base, {}, 'wrong-token-0123456789abcdef0123456789')).status).toBe(401);
    expect((await internal(harness, base, {}, TOKEN)).status).toBe(401);
    const registration = { registrationId: randomUUID(), capUsd: '6', suiteDigest: 'd'.repeat(64), versions: { source: 's', build: 'b', prompt: 'p', tools: 't', provider: 'anthropic:test' } };
    const registered = await internal(harness, base, registration, EVAL_TOKEN);
    expect(registered).toMatchObject({ status: 200, body: { capUnits: 60_000_000, state: 'open' } });
    expect((await internal(harness, base, registration, EVAL_TOKEN)).body).toEqual(registered.body);
    const evalRun = registered.body.runId as string;
    const attempt = await internal(harness, `${base}/${evalRun}/attempts`, { turn: 0, ordinal: 0, requestHash: 'e'.repeat(64), model: 'claude-opus-5-5', maxOutputTokens: 8192 }, EVAL_TOKEN);
    expect(attempt).toMatchObject({ status: 200, body: { state: 'reserved', reservedUnits: CEILING, replayed: false } });
    const attemptId = attempt.body.attemptId as string;
    expect((await internal(harness, `${base}/${evalRun}/attempts/${attemptId}/dispatch`, {}, EVAL_TOKEN)).status).toBe(200);
    expect((await internal(harness, `${base}/${evalRun}/attempts/${attemptId}/dispatch`, {}, EVAL_TOKEN)).body).toMatchObject({ reason: 'dispatch_already_granted' });

    // While the evaluation request is in flight, the packaged worker cannot dispatch: it releases its reservation and sends nothing.
    const busyRun = await startLiveRun(harness, 'case-live-busy');
    expect((await waitForRun(harness, 'case-live-busy', busyRun, 'failed')).run.failureCode).toBe('admission_unavailable');
    expect(client.sent).toEqual([]);
    expect(ledgerRun(harness, busyRun).attempts.map((item) => item.state)).toEqual(['released']);

    const usage = { usage: { inputTokens: 10, outputTokens: 5, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cacheWrite1hInputTokens: 0, serverToolRequests: 0, serviceTier: 'standard', inferenceGeo: null }, providerRequestId: null, providerMessageId: null, model: 'claude-opus-5-5' };
    expect((await internal(harness, `${base}/${evalRun}/attempts/${attemptId}/usage`, usage, EVAL_TOKEN)).body).toEqual({ attemptId, state: 'reconciled', actualUnits: 10 * 40 + 5 * 200 });
    const stopped = await internal(harness, `${base}/${evalRun}/stop`, {}, EVAL_TOKEN);
    expect(stopped.body).toMatchObject({ state: 'stopped', runCommittedUnits: 1400, heldUnits: 0 });
    await stopHarness(harness);
  });
});
