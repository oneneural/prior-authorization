import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi, Health } from '@pa/api';
import type { WorkerConfig } from '@pa/config';
import { CreateProbeResponse, ErrorResponse, ReadinessResponse } from '@pa/contracts';
import { createDatabase, createRuntimeBoss, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, withConnection, type TestDatabase } from '@pa/db/testing';

import { startWorker, type RunningWorker } from '../src/worker.js';

// Readiness, draining and the drain deadline against a real database, API and
// worker in one process. The container tests repeat this through s6 and signals.

const TOKEN = 'drain-worker-service-token-0123456789abcdef';
const core = { appId: 'prior-authorization', dataMode: 'fixture', agentMode: 'rules', authMode: 'fixture', logLevel: 'silent' } as const;

let database: TestDatabase;
let apiHandle: DatabaseHandle;
let workerHandle: DatabaseHandle;
let apiBoss: PgBoss;
let health: Health;
let api: ReturnType<typeof buildApi>;
let origin: string;
const running: RunningWorker[] = [];

async function readiness(): Promise<{ status: number; body: ReadinessResponse }> {
  const response = await fetch(`${origin}/api/health/ready`);
  return { status: response.status, body: ReadinessResponse.parse(await response.json()) };
}

async function submit(): Promise<Response> {
  return fetch(`${origin}/api/pilot/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `drain-${randomUUID()}` },
    body: JSON.stringify({ label: 'synthetic drain probe' }),
  });
}

async function jobState(probeId: string): Promise<{ state: string; status: string } | undefined> {
  return withConnection(database.urls.admin, async (client) => {
    const { rows } = await client.query<{ state: string; status: string }>(
      'SELECT j.state, p.status FROM pa_app.pilot_probes p JOIN pgboss.job j ON j.id = p.job_id WHERE p.probe_id = $1',
      [probeId],
    );
    return rows[0];
  });
}

/** Starts a worker on its own queue instance; `started` resolves when it begins a job. */
async function startTestWorker(testJobDelayMs: number): Promise<{ worker: RunningWorker; started: Promise<string> }> {
  const boss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  const config: WorkerConfig = { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 1, testJobDelayMs, anthropicApiKeyFile: null };
  let onStarted: (jobId: string) => void = () => undefined;
  const started = new Promise<string>((resolve) => {
    onStarted = resolve;
  });
  const worker = await startWorker({
    config,
    db: workerHandle.db,
    boss,
    apiOrigin: origin,
    heartbeatIntervalMs: 200,
    log: (message, fields) => {
      if (message === 'pilot job started') {
        onStarted(String(fields?.jobId));
      }
    },
  });
  running.push(worker);
  return { worker, started };
}

beforeAll(async () => {
  database = await createTestDatabase();
  apiHandle = createDatabase(database.urls.api, 'pa-api-drain');
  workerHandle = createDatabase(database.urls.worker, 'pa-worker-drain');
  apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  health = new Health(apiHandle.db);
  await health.captureSchemaVersion();
  api = buildApi({ config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'test', authSecret: 'worker-test-auth-secret-0123456789abcdef', publicOrigin: 'http://127.0.0.1:3105', accountingLedgerFile: null, evaluationAdmissionToken: null }, db: apiHandle.db, boss: apiBoss, health, logger: false });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
});

afterAll(async () => {
  // drain() is idempotent enough for cleanup: a stopped worker has nothing left to stop.
  for (const worker of running) {
    await worker.drain(1_000).catch(() => undefined);
  }
  await api?.close();
  await apiBoss?.stop({ graceful: false, close: true });
  await apiHandle?.close();
  await workerHandle?.close();
  await database?.drop();
});

describe('readiness and worker drain', () => {
  it('is not ready until the worker of this process reports a heartbeat, and liveness never needs it', async () => {
    // A heartbeat row in the database (as left by an earlier process) does not count.
    await withConnection(database.urls.admin, (client) =>
      client.query(
        `INSERT INTO pa_worker.worker_heartbeats (worker_id, boot_id, started_at, last_seen_at) VALUES ('previous-process', $1, now(), now())`,
        [randomUUID()],
      ),
    );
    expect(await readiness()).toEqual({ status: 503, body: { ready: false, reasons: ['worker_heartbeat_missing'] } });
    expect((await fetch(`${origin}/api/health/live`)).status).toBe(200);

    await startTestWorker(0);
    await expect.poll(async () => (await readiness()).body, { timeout: 5_000, interval: 100 }).toEqual({ ready: true, reasons: [] });
  });

  it('refuses new submissions while draining but lets the active job report through the internal route', async () => {
    const { worker, started } = await startTestWorker(1_500);
    // Retire the worker from the previous test so only this one can claim the job.
    await running[0]?.drain(2_000);

    const created = await submit();
    expect(created.status).toBe(201);
    const { probe } = CreateProbeResponse.parse(await created.json());
    await started;
    expect((await jobState(probe.probeId))?.state).toBe('active');

    health.startDraining();
    const refused = await submit();
    expect(refused.status).toBe(503);
    expect(ErrorResponse.parse(await refused.json()).error.code).toBe('shutting_down');
    expect((await readiness()).body.reasons).toContain('shutting_down');

    const result = await worker.drain(10_000);
    expect(result).toEqual({ drained: true, interruptedJobIds: [] });
    expect(await jobState(probe.probeId)).toEqual({ state: 'completed', status: 'completed' });
  });

  it('returns a job that outlasts the drain deadline to the queue without completing it', async () => {
    // Accept submissions again for this case only; a real process never leaves draining.
    const fresh = new Health(apiHandle.db);
    await fresh.captureSchemaVersion();
    const local = buildApi({ config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'test', authSecret: 'worker-test-auth-secret-0123456789abcdef', publicOrigin: 'http://127.0.0.1:3105', accountingLedgerFile: null, evaluationAdmissionToken: null }, db: apiHandle.db, boss: apiBoss, health: fresh, logger: false });
    const localOrigin = await local.listen({ host: '127.0.0.1', port: 0 });
    try {
      const boss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
      let onStarted: (jobId: string) => void = () => undefined;
      const started = new Promise<string>((resolve) => {
        onStarted = resolve;
      });
      const worker = await startWorker({
        config: { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 1, testJobDelayMs: 5_000, anthropicApiKeyFile: null },
        db: workerHandle.db,
        boss,
        apiOrigin: localOrigin,
        heartbeatIntervalMs: 200,
        log: (message, fields) => message === 'pilot job started' && onStarted(String(fields?.jobId)),
      });
      running.push(worker);
      const created = await fetch(`${localOrigin}/api/pilot/probes`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': `drain-${randomUUID()}` },
        body: JSON.stringify({ label: 'synthetic long probe' }),
      });
      const { probe } = CreateProbeResponse.parse(await created.json());
      const jobId = await started;

      const result = await worker.drain(500);
      expect(result).toEqual({ drained: false, interruptedJobIds: [jobId] });
      expect(await jobState(probe.probeId)).toEqual({ state: 'retry', status: 'queued' });
    } finally {
      await local.close();
    }
  });
});
