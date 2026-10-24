import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CreateProbeResponse, ErrorResponse } from '@pa/contracts';
import { enqueuePilotJob, insertProbe, PILOT_QUEUE } from '@pa/db';

import { adminQuery, jobCount, probeSnapshot, startApiHarness, type ApiHarness } from './support.js';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await startApiHarness();
});

afterAll(async () => {
  await harness?.close();
});

function newProbe() {
  const probeId = randomUUID();
  return { probeId, jobId: randomUUID(), idempotencyKey: `key-${probeId}`, requestHash: 'h', label: 'synthetic probe' };
}

function postProbe(key: string, label: string) {
  return harness.app.inject({
    method: 'POST',
    url: '/api/pilot/probes',
    headers: { 'idempotency-key': key, 'content-type': 'application/json' },
    payload: { label },
  });
}

describe('atomic probe insert and enqueue (BA-05)', () => {
  it('rolls back both the probe and its job when the transaction fails after send()', async () => {
    const probe = newProbe();
    let visibleInside = 0;

    await expect(
      harness.handle.db.transaction(async (tx) => {
        await insertProbe(tx, probe);
        await enqueuePilotJob(harness.apiBoss, tx, probe.jobId, { probeId: probe.probeId });
        const { rows } = await tx.execute<{ count: number }>(sql`SELECT count(*)::int AS count FROM pgboss.job WHERE id = ${probe.jobId}`);
        visibleInside = rows[0]?.count ?? 0;
        throw new Error('forced rollback after send');
      }),
    ).rejects.toThrow('forced rollback after send');

    // The job was written through the transaction, then removed by its rollback.
    expect(visibleInside).toBe(1);
    expect(await probeSnapshot(harness.database, probe.probeId)).toBeUndefined();
    expect(await jobCount(harness.database, probe.jobId)).toBe(0);
  });

  it('does not let a consumer claim a job while the enqueuing transaction is uncommitted', async () => {
    const probe = newProbe();
    const handled: string[] = [];
    const workerId = await harness.workerBoss.work(PILOT_QUEUE, { pollingIntervalSeconds: 0.5 }, (jobs) => {
      handled.push(...jobs.map((job) => job.id));
      return Promise.resolve();
    });

    let commit!: () => void;
    const held = new Promise<void>((resolve) => (commit = resolve));
    let enqueued!: () => void;
    const ready = new Promise<void>((resolve) => (enqueued = resolve));
    const transaction = harness.handle.db.transaction(async (tx) => {
      await insertProbe(tx, probe);
      await enqueuePilotJob(harness.apiBoss, tx, probe.jobId, { probeId: probe.probeId });
      enqueued();
      await held;
    });

    try {
      await ready;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(await harness.workerBoss.fetch(PILOT_QUEUE)).toEqual([]);
      expect(handled).not.toContain(probe.jobId);

      commit();
      await transaction;
      await expect.poll(() => handled, { timeout: 5000, interval: 100 }).toContain(probe.jobId);
    } finally {
      commit();
      await harness.workerBoss.offWork(PILOT_QUEUE, { id: workerId });
    }
  });
});

describe('idempotent probe submission', () => {
  it('creates once and replays the recorded probe for the same key and payload', async () => {
    const key = `replay-${randomUUID()}`;
    const first = await postProbe(key, 'synthetic replay probe');
    expect(first.statusCode).toBe(201);
    const created = CreateProbeResponse.parse(first.json());
    expect(created.replayed).toBe(false);
    expect(created.probe).toMatchObject({ status: 'queued', synthetic: true, label: 'synthetic replay probe' });

    const second = await postProbe(key, 'synthetic replay probe');
    expect(second.statusCode).toBe(200);
    const replayed = CreateProbeResponse.parse(second.json());
    expect(replayed.replayed).toBe(true);
    expect(replayed.probe.probeId).toBe(created.probe.probeId);

    const [row] = await adminQuery<{ job_id: string }>(harness.database, 'SELECT job_id FROM pa_app.pilot_probes WHERE idempotency_key = $1', [key]);
    expect(await jobCount(harness.database, row!.job_id)).toBe(1);
    const [jobs] = await adminQuery<{ count: number }>(harness.database, "SELECT count(*)::int AS count FROM pgboss.job WHERE data->>'probeId' = $1", [created.probe.probeId]);
    expect(jobs?.count).toBe(1);
  });

  it('rejects a changed payload under the same key and leaves the recorded probe unchanged', async () => {
    const key = `conflict-${randomUUID()}`;
    const created = CreateProbeResponse.parse((await postProbe(key, 'original payload')).json());
    const before = await probeSnapshot(harness.database, created.probe.probeId);

    const changed = await postProbe(key, 'changed payload');
    expect(changed.statusCode).toBe(409);
    expect(ErrorResponse.parse(changed.json()).error.code).toBe('idempotency_conflict');
    expect(await probeSnapshot(harness.database, created.probe.probeId)).toEqual(before);
    const [count] = await adminQuery<{ count: number }>(harness.database, 'SELECT count(*)::int AS count FROM pa_app.pilot_probes WHERE idempotency_key = $1', [key]);
    expect(count?.count).toBe(1);
  });

  it('creates exactly one probe and job for concurrent submissions with one key', async () => {
    const key = `concurrent-${randomUUID()}`;
    const responses = await Promise.all(Array.from({ length: 6 }, () => postProbe(key, 'concurrent payload')));
    expect(responses.map((response) => response.statusCode).sort()).toEqual([200, 200, 200, 200, 200, 201]);
    const probeIds = new Set(responses.map((response) => CreateProbeResponse.parse(response.json()).probe.probeId));
    expect(probeIds.size).toBe(1);
    const [jobs] = await adminQuery<{ count: number }>(harness.database, "SELECT count(*)::int AS count FROM pgboss.job WHERE data->>'probeId' = $1", [[...probeIds][0]]);
    expect(jobs?.count).toBe(1);
  });

  it('requires a well-formed idempotency key', async () => {
    const response = await postProbe('short', 'payload');
    expect(response.statusCode).toBe(400);
    expect(ErrorResponse.parse(response.json()).error.code).toBe('invalid_idempotency_key');
  });
});
