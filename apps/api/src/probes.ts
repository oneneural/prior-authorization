import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { CreateProbeRequest, PilotProbe, PilotProbeSummary, WorkerResultReport } from '@pa/contracts';
import {
  completeProbe,
  enqueuePilotJob,
  findProbeByIdempotencyKey,
  insertProbe,
  lockProbeByJobId,
  PILOT_QUEUE,
  type Database,
  type PgBoss,
  type ProbeRow,
} from '@pa/db';

/** Short, non-reversible key fingerprint for logs; the key itself is never logged. */
export function idempotencyKeyDigest(key: string): string {
  return createHash('sha256').update(key).digest('hex').slice(0, 12);
}

export function toProbeSummary(row: ProbeRow): PilotProbeSummary {
  return {
    probeId: row.probeId,
    synthetic: true,
    label: row.label,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    completedAt: row.completedAt?.toISOString() ?? null,
    workerResult: row.workerResult ?? null,
  };
}

/** Full probe for its submitter, who already holds the idempotency key. */
export function toProbeDto(row: ProbeRow): PilotProbe {
  return { ...toProbeSummary(row), idempotencyKey: row.idempotencyKey };
}

/** Hash of the normalised request; a key may only ever be replayed with the same payload. */
export function requestHash(request: CreateProbeRequest): string {
  return createHash('sha256').update(JSON.stringify({ label: request.label })).digest('hex');
}

export type CreateProbeOutcome =
  | { kind: 'created'; probe: ProbeRow }
  | { kind: 'replayed'; probe: ProbeRow }
  | { kind: 'conflict' };

/**
 * Inserts the probe and enqueues its job in one transaction. A duplicate key
 * enqueues nothing: the same payload returns the recorded probe and a changed
 * payload is a conflict.
 */
export async function createProbe(db: Database, boss: PgBoss, idempotencyKey: string, request: CreateProbeRequest): Promise<CreateProbeOutcome> {
  const hash = requestHash(request);
  const created = await db.transaction(async (tx) => {
    const probeId = randomUUID();
    const jobId = randomUUID();
    const row = await insertProbe(tx, { probeId, idempotencyKey, requestHash: hash, label: request.label, jobId });
    if (row !== undefined) {
      await enqueuePilotJob(boss, tx, jobId, { probeId });
    }
    return row;
  });
  if (created !== undefined) {
    return { kind: 'created', probe: created };
  }
  const existing = await findProbeByIdempotencyKey(db, idempotencyKey);
  if (existing === undefined) {
    throw new Error('idempotency key conflicted but no probe was found');
  }
  return existing.requestHash === hash ? { kind: 'replayed', probe: existing } : { kind: 'conflict' };
}

export type RecordResultOutcome =
  | { kind: 'recorded'; probe: ProbeRow }
  | { kind: 'replayed'; probe: ProbeRow }
  | { kind: 'reference_mismatch' }
  | { kind: 'job_not_active' }
  | { kind: 'result_conflict' };

/**
 * Accepts a worker result only for the probe that owns the persisted job, while
 * that job is actively claimed. The submitted probe ID is checked against the
 * job record and never used on its own to locate the probe.
 */
export async function recordWorkerResult(db: Database, boss: PgBoss, report: WorkerResultReport): Promise<RecordResultOutcome> {
  return db.transaction(async (tx) => {
    const probe = await lockProbeByJobId(tx, report.jobId);
    if (probe === undefined || probe.probeId !== report.probeId) {
      return { kind: 'reference_mismatch' };
    }
    if (probe.status === 'completed') {
      // A redelivered job after a lost acknowledgement reports the identical result.
      return isDeepStrictEqual(probe.workerResult, report.result) ? { kind: 'replayed', probe } : { kind: 'result_conflict' };
    }
    const job = await boss.getJobById(PILOT_QUEUE, report.jobId);
    if (job?.state !== 'active') {
      return { kind: 'job_not_active' };
    }
    return { kind: 'recorded', probe: await completeProbe(tx, probe.probeId, report.result) };
  });
}
