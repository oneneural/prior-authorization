import { createHash, randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CreateProbeResponse, ErrorResponse, WORKER_RESULT_PATH, WorkerResultAck, type WorkerResult } from '@pa/contracts';
import { PILOT_QUEUE } from '@pa/db';

import { adminQuery, probeSnapshot, startApiHarness, TEST_TOKEN, type ApiHarness } from './support.js';

let harness: ApiHarness;

beforeAll(async () => {
  harness = await startApiHarness();
});

afterAll(async () => {
  await harness?.close();
});

const RESULT_URL = WORKER_RESULT_PATH;

function resultFor(probeId: string): WorkerResult {
  return { outcome: 'processed', probeDigest: createHash('sha256').update(probeId).digest('hex') };
}

async function createQueuedProbe(): Promise<{ probeId: string; jobId: string }> {
  const response = await harness.app.inject({
    method: 'POST',
    url: '/api/pilot/probes',
    headers: { 'idempotency-key': `internal-${randomUUID()}` },
    payload: { label: 'synthetic internal-route probe' },
  });
  const { probe } = CreateProbeResponse.parse(response.json());
  const [row] = await adminQuery<{ job_id: string }>(harness.database, 'SELECT job_id FROM pa_app.pilot_probes WHERE probe_id = $1', [probe.probeId]);
  return { probeId: probe.probeId, jobId: row!.job_id };
}

/** Claims every available pilot job, as a worker fetch would. */
async function claimJobs(): Promise<string[]> {
  const jobs = await harness.workerBoss.fetch(PILOT_QUEUE, { batchSize: 50 });
  return jobs.map((job) => job.id);
}

function report(body: unknown, authorization?: string) {
  return harness.app.inject({
    method: 'POST',
    url: RESULT_URL,
    headers: authorization === undefined ? {} : { authorization },
    payload: body as Record<string, unknown>,
  });
}

function errorCode(response: { json(): unknown }): string {
  return ErrorResponse.parse(response.json()).error.code;
}

describe('internal worker result route', () => {
  it.each([
    ['an absent', undefined],
    ['a wrong', `Bearer wrong-${TEST_TOKEN}`],
    ['a wrong-scheme', `Basic ${TEST_TOKEN}`],
    ['an empty bearer', 'Bearer '],
  ])('rejects %s service token and leaves the probe unchanged', async (_label, authorization) => {
    const probe = await createQueuedProbe();
    await claimJobs();
    const before = await probeSnapshot(harness.database, probe.probeId);

    const response = await report({ ...probe, result: resultFor(probe.probeId) }, authorization);
    expect(response.statusCode).toBe(401);
    expect(errorCode(response)).toBe('unauthorized');
    expect(await probeSnapshot(harness.database, probe.probeId)).toEqual(before);
  });

  it('rejects a probe reference that does not match the persisted job record', async () => {
    const target = await createQueuedProbe();
    const other = await createQueuedProbe();
    await claimJobs();
    const beforeTarget = await probeSnapshot(harness.database, target.probeId);
    const beforeOther = await probeSnapshot(harness.database, other.probeId);

    // The other probe's ID with the target's active job: the probe ID alone grants nothing.
    const response = await report({ jobId: target.jobId, probeId: other.probeId, result: resultFor(other.probeId) }, `Bearer ${TEST_TOKEN}`);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('job_reference_mismatch');
    expect(await probeSnapshot(harness.database, target.probeId)).toEqual(beforeTarget);
    expect(await probeSnapshot(harness.database, other.probeId)).toEqual(beforeOther);
  });

  it('rejects an unknown job reference', async () => {
    const probe = await createQueuedProbe();
    const before = await probeSnapshot(harness.database, probe.probeId);
    const response = await report({ jobId: randomUUID(), probeId: probe.probeId, result: resultFor(probe.probeId) }, `Bearer ${TEST_TOKEN}`);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('job_reference_mismatch');
    expect(await probeSnapshot(harness.database, probe.probeId)).toEqual(before);
  });

  it('rejects a result for a job no worker has claimed', async () => {
    const probe = await createQueuedProbe();
    const before = await probeSnapshot(harness.database, probe.probeId);
    const response = await report({ ...probe, result: resultFor(probe.probeId) }, `Bearer ${TEST_TOKEN}`);
    expect(response.statusCode).toBe(409);
    expect(errorCode(response)).toBe('job_not_active');
    expect(await probeSnapshot(harness.database, probe.probeId)).toEqual(before);
  });

  it('records a matching result for an active job, replays it, and refuses a different one', async () => {
    const probe = await createQueuedProbe();
    expect(await claimJobs()).toContain(probe.jobId);

    const accepted = await report({ ...probe, result: resultFor(probe.probeId) }, `Bearer ${TEST_TOKEN}`);
    expect(accepted.statusCode).toBe(200);
    const ack = WorkerResultAck.parse(accepted.json());
    expect(ack).toMatchObject({ replayed: false, probe: { status: 'completed', workerResult: resultFor(probe.probeId) } });

    const replay = await report({ ...probe, result: resultFor(probe.probeId) }, `Bearer ${TEST_TOKEN}`);
    expect(replay.statusCode).toBe(200);
    expect(WorkerResultAck.parse(replay.json()).replayed).toBe(true);

    const completed = await probeSnapshot(harness.database, probe.probeId);
    const conflicting = await report({ ...probe, result: resultFor(randomUUID()) }, `Bearer ${TEST_TOKEN}`);
    expect(conflicting.statusCode).toBe(409);
    expect(errorCode(conflicting)).toBe('result_conflict');
    expect(await probeSnapshot(harness.database, probe.probeId)).toEqual(completed);
  });

  it('is not served under the public /api prefix', async () => {
    const response = await harness.app.inject({ method: 'POST', url: `/api${RESULT_URL}`, headers: { authorization: `Bearer ${TEST_TOKEN}` }, payload: {} });
    expect(response.statusCode).toBe(404);
  });
});
