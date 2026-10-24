import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PILOT_QUEUE } from '../src/constants.js';
import { createRuntimeBoss, startRuntimeBoss, type PgBoss } from '../src/queue.js';
import { createTestDatabase, withConnection, type TestDatabase } from '../src/testing.js';

// Runs real pg-boss supervision and maintenance as the runtime roles after the
// function grants revoke PUBLIC EXECUTE, so a maintenance step that needed a
// revoked function or a missing grant surfaces here rather than in production.

const SECOND = { superviseIntervalSeconds: 1, monitorIntervalSeconds: 1, maintenanceIntervalSeconds: 1 } as const;

let database: TestDatabase;
let api: PgBoss;
let worker: PgBoss;
const errors: { role: string; error: unknown }[] = [];

async function jobRow(id: string): Promise<{ state: string; retry_count: number } | undefined> {
  return withConnection(database.urls.admin, async (client) => {
    const { rows } = await client.query<{ state: string; retry_count: number }>('SELECT state, retry_count FROM pgboss.job WHERE id = $1', [id]);
    return rows[0];
  });
}

async function admin(statement: string, values: unknown[]): Promise<void> {
  await withConnection(database.urls.admin, (client) => client.query(statement, values));
}

beforeAll(async () => {
  database = await createTestDatabase();
  api = createRuntimeBoss(database.urls.api, 'api', SECOND);
  api.on('error', (error) => errors.push({ role: 'api', error }));
  worker = createRuntimeBoss(database.urls.worker, 'worker', SECOND);
  worker.on('error', (error) => errors.push({ role: 'worker', error }));
  await startRuntimeBoss(api);
  await startRuntimeBoss(worker);
});

afterAll(async () => {
  await worker?.stop({ graceful: false, close: true });
  await api?.stop({ graceful: false, close: true });
  await database?.drop();
});

describe('pg-boss supervision under runtime grants', () => {
  it('expires, retains and deletes jobs as the worker role with no permission errors', async () => {
    // An active job past its expiry: monitoring must fail it into retry.
    const expiring = await api.send(PILOT_QUEUE, { probeId: randomUUID() }, { expireInSeconds: 1 });
    // A completed job past its retention: maintenance must delete it.
    const finished = await api.send(PILOT_QUEUE, { probeId: randomUUID() });
    // A queued job past keep_until: maintenance must delete it.
    const stale = await api.send(PILOT_QUEUE, { probeId: randomUUID() }, { startAfter: 3600 });
    expect([expiring, finished, stale].every((id) => typeof id === 'string')).toBe(true);

    const claimed = await worker.fetch(PILOT_QUEUE, { batchSize: 2 });
    const ids = claimed.map((job) => job.id);
    expect(ids.sort()).toEqual([expiring, finished].sort());
    await worker.complete(PILOT_QUEUE, finished ?? '');
    await admin("UPDATE pgboss.job SET completed_on = now() - interval '30 days' WHERE id = $1", [finished]);
    await admin("UPDATE pgboss.job SET keep_until = now() - interval '1 hour' WHERE id = $1", [stale]);

    // Background supervision (1 s intervals) plus explicit on-demand passes, whose errors reject.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    await worker.supervise();
    await expect.poll(async () => (await jobRow(expiring ?? ''))?.state, { timeout: 15_000, interval: 250 }).toBe('retry');
    await worker.supervise();
    await expect.poll(async () => jobRow(finished ?? ''), { timeout: 15_000, interval: 250 }).toBeUndefined();
    await expect.poll(async () => jobRow(stale ?? ''), { timeout: 15_000, interval: 250 }).toBeUndefined();
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    expect(errors.map(({ role, error }) => `${role}: ${String(error)}`)).toEqual([]);
  });

  it('keeps the API producer free of permission errors across supervision intervals', async () => {
    const id = await api.send(PILOT_QUEUE, { probeId: randomUUID() });
    expect((await api.getJobById(PILOT_QUEUE, id ?? ''))?.state).toBe('created');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(errors.filter(({ role }) => role === 'api').map(({ error }) => String(error))).toEqual([]);
  });

  it('refuses explicit supervision by the API role on table grants only, never on a pg-boss function', async () => {
    // The API never supervises (supervise is false for it); this shows the function
    // revoke is not what stops it.
    const outcome = await api.supervise().then(
      () => 'completed',
      (error: unknown) => String(error),
    );
    expect(outcome).toMatch(/permission denied for table/);
    const messages = [outcome, ...errors.map(({ error }) => String(error))];
    expect(messages.filter((message) => /permission denied for function/.test(message))).toEqual([]);
  });
});
