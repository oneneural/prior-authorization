import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '@pa/api';
import type { WorkerConfig } from '@pa/config';
import { CreateProbeResponse, StatusResponse } from '@pa/contracts';
import { createDatabase, createRuntimeBoss, PILOT_QUEUE, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, withConnection, type TestDatabase } from '@pa/db/testing';

import { pilotResult, startWorker, type RunningWorker } from '../src/worker.js';

const TOKEN = 'flow-worker-service-token-0123456789abcdef';

let database: TestDatabase;
let apiHandle: DatabaseHandle;
let workerHandle: DatabaseHandle;
let apiBoss: PgBoss;
let workerBoss: PgBoss;
let api: ReturnType<typeof buildApi>;
let worker: RunningWorker;
let origin: string;

interface QueueJob {
  state: string;
  retry_count: number;
  output: unknown;
}

async function queueJob(jobId: string): Promise<QueueJob | undefined> {
  return withConnection(database.urls.admin, async (client) => {
    const { rows } = await client.query<QueueJob>('SELECT state, retry_count, output FROM pgboss.job WHERE id = $1', [jobId]);
    return rows[0];
  });
}

const core = { appId: 'prior-authorization', dataMode: 'fixture', agentMode: 'rules', authMode: 'fixture', logLevel: 'silent' } as const;

beforeAll(async () => {
  database = await createTestDatabase();
  apiHandle = createDatabase(database.urls.api, 'pa-api-flow');
  workerHandle = createDatabase(database.urls.worker, 'pa-worker-flow');
  apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  workerBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  api = buildApi({ config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'test', authSecret: 'worker-test-auth-secret-0123456789abcdef', publicOrigin: 'http://127.0.0.1:3105', accountingLedgerFile: null, evaluationAdmissionToken: null }, db: apiHandle.db, boss: apiBoss, logger: false });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
  const config: WorkerConfig = { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null };
  worker = await startWorker({ config, db: workerHandle.db, boss: workerBoss, apiOrigin: origin, workerId: 'flow-worker' });
});

afterAll(async () => {
  await worker?.drain(5_000);
  await api?.close();
  await apiBoss?.stop({ graceful: false, close: true });
  await apiHandle?.close();
  await workerHandle?.close();
  await database?.drop();
});

describe('API to queue to worker to API flow', () => {
  it('processes a submitted probe through the restricted worker and records its heartbeat', async () => {
    const created = await fetch(`${origin}/api/pilot/probes`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `flow-${randomUUID()}` },
      body: JSON.stringify({ label: 'synthetic flow probe' }),
    });
    expect(created.status).toBe(201);
    const { probe } = CreateProbeResponse.parse(await created.json());

    await expect
      .poll(
        async () => {
          const status = StatusResponse.parse(await (await fetch(`${origin}/api/status`)).json());
          return status.probes.find((candidate) => candidate.probeId === probe.probeId)?.status;
        },
        { timeout: 10_000, interval: 200 },
      )
      .toBe('completed');

    const status = StatusResponse.parse(await (await fetch(`${origin}/api/status`)).json());
    expect(status.probes.find((candidate) => candidate.probeId === probe.probeId)?.workerResult).toEqual(pilotResult(probe.probeId));

    const { jobId, heartbeat } = await withConnection(database.urls.admin, async (client) => {
      const persisted = await client.query<{ job_id: string }>('SELECT job_id FROM pa_app.pilot_probes WHERE probe_id = $1', [probe.probeId]);
      const beats = await client.query<{ worker_id: string; boot_id: string; last_job_id: string | null }>(
        'SELECT worker_id, boot_id, last_job_id FROM pa_worker.worker_heartbeats',
      );
      return { jobId: persisted.rows[0]?.job_id, heartbeat: beats.rows };
    });
    expect(jobId).toBeDefined();
    expect(heartbeat).toEqual([{ worker_id: 'flow-worker', boot_id: worker.bootId, last_job_id: jobId }]);

    // The persisted job itself reaches pg-boss's completed state after the handler returns.
    await expect.poll(async () => (await queueJob(jobId ?? ''))?.state, { timeout: 10_000, interval: 200 }).toBe('completed');
  });

  it('fails a malformed job payload permanently instead of retrying it', async () => {
    const jobId = await apiBoss.send(PILOT_QUEUE, { probeId: 'not-a-probe-id' });
    expect(jobId).toEqual(expect.any(String));

    await expect.poll(async () => (await queueJob(jobId ?? ''))?.state, { timeout: 10_000, interval: 200 }).toBe('failed');
    expect(await queueJob(jobId ?? '')).toMatchObject({ retry_count: 0, output: { error: 'malformed_payload' } });
  });
});
