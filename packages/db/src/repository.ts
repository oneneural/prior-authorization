import { desc, eq, sql } from 'drizzle-orm';

import type { WorkerResult } from '@pa/contracts';

import type { Queryable, Transaction } from './client.js';
import { pilotProbes, workerHeartbeats } from './schema.js';

export type ProbeRow = typeof pilotProbes.$inferSelect;
export type NewProbeRow = Pick<typeof pilotProbes.$inferInsert, 'probeId' | 'idempotencyKey' | 'requestHash' | 'label' | 'jobId'>;

/** Inserts a probe unless its idempotency key exists; returns undefined on a duplicate key. */
export async function insertProbe(tx: Transaction, probe: NewProbeRow): Promise<ProbeRow | undefined> {
  const [row] = await tx
    .insert(pilotProbes)
    .values({ ...probe, synthetic: true, status: 'queued' })
    .onConflictDoNothing({ target: pilotProbes.idempotencyKey })
    .returning();
  return row;
}

export async function findProbeByIdempotencyKey(db: Queryable, idempotencyKey: string): Promise<ProbeRow | undefined> {
  const [row] = await db.select().from(pilotProbes).where(eq(pilotProbes.idempotencyKey, idempotencyKey));
  return row;
}

export async function findProbeById(db: Queryable, probeId: string): Promise<ProbeRow | undefined> {
  const [row] = await db.select().from(pilotProbes).where(eq(pilotProbes.probeId, probeId));
  return row;
}

/** Locks the probe that owns a persisted job ID, serialising result receipts for that job. */
export async function lockProbeByJobId(tx: Transaction, jobId: string): Promise<ProbeRow | undefined> {
  const [row] = await tx.select().from(pilotProbes).where(eq(pilotProbes.jobId, jobId)).for('update');
  return row;
}

export async function completeProbe(tx: Transaction, probeId: string, result: WorkerResult): Promise<ProbeRow> {
  const [row] = await tx
    .update(pilotProbes)
    .set({ status: 'completed', workerResult: result, completedAt: sql`now()`, updatedAt: sql`now()` })
    .where(eq(pilotProbes.probeId, probeId))
    .returning();
  if (row === undefined) {
    throw new Error('probe disappeared while locked');
  }
  return row;
}

export async function listRecentProbes(db: Queryable, limit: number): Promise<ProbeRow[]> {
  return db.select().from(pilotProbes).orderBy(desc(pilotProbes.createdAt)).limit(limit);
}

export async function databaseNow(db: Queryable): Promise<Date> {
  // Drizzle's raw execute returns timestamps as strings; epoch milliseconds avoid parsing them.
  const result = await db.execute<{ epoch_ms: number }>(sql`SELECT (extract(epoch FROM now()) * 1000)::float8 AS epoch_ms`);
  const epochMs = result.rows[0]?.epoch_ms;
  if (typeof epochMs !== 'number') {
    throw new Error('database clock query returned no timestamp');
  }
  return new Date(epochMs);
}

/** Fails when the API's application table is missing or not granted; reads no rows. */
export async function checkApplicationSchema(db: Queryable): Promise<void> {
  await db.execute(sql`SELECT 1 FROM pa_app.pilot_probes LIMIT 0`);
}

/** The installed pg-boss schema version, readable by both runtime roles. */
export async function queueSchemaVersion(db: Queryable): Promise<number | undefined> {
  const result = await db.execute<{ version: number }>(sql`SELECT version FROM pgboss.version`);
  const version = result.rows[0]?.version;
  return typeof version === 'number' ? version : undefined;
}

export interface Heartbeat {
  workerId: string;
  bootId: string;
  startedAt: Date;
  lastJobId: string | null;
}

export async function recordHeartbeat(db: Queryable, heartbeat: Heartbeat): Promise<void> {
  await db
    .insert(workerHeartbeats)
    .values({ ...heartbeat, lastSeenAt: sql`now()` })
    .onConflictDoUpdate({
      target: workerHeartbeats.workerId,
      set: {
        bootId: heartbeat.bootId,
        startedAt: heartbeat.startedAt,
        lastSeenAt: sql`now()`,
        lastJobId: heartbeat.lastJobId,
      },
    });
}
