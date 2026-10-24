import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type ConstructorOptions } from 'pg-boss';

import { AGENT_QUEUE, WORKFLOW_QUEUE, CASE_QUEUE, type AgentJobPayload, type CaseJobPayload, type PilotJobPayload } from '@pa/contracts';

import { CONNECT_TIMEOUT_MS, type Transaction } from './client.js';
import { PGBOSS_SCHEMA, PILOT_QUEUE } from './constants.js';

export { PgBoss };
export type { JobResult } from 'pg-boss';

export type RuntimeRole = 'api' | 'worker';

/** Supervision intervals; tests shorten them to run real maintenance passes quickly. */
export type SupervisionTiming = Pick<ConstructorOptions, 'superviseIntervalSeconds' | 'monitorIntervalSeconds' | 'maintenanceIntervalSeconds'>;

export class QueueSchemaError extends Error {
  constructor(cause: unknown) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    super(
      `Queue schema "${PGBOSS_SCHEMA}" is missing or incompatible with the pinned pg-boss version (${reason}). ` +
        'Run the database migrator before starting runtime services.',
      { cause },
    );
    this.name = 'QueueSchemaError';
  }
}

/**
 * pg-boss for a runtime role. Runtime never installs or migrates the queue
 * schema (`migrate: false`) and never runs cron scheduling. Only the worker
 * supervises, so expiry, retry and retention maintenance run on the consumer side.
 * Maintenance features that issue DDL (daily queue-stats partitions and
 * concurrent reindexing) stay off because runtime roles own no objects.
 */
export function createRuntimeBoss(connectionString: string, role: RuntimeRole, timing: SupervisionTiming = {}): PgBoss {
  return new PgBoss({
    ...timing,
    connectionString,
    schema: PGBOSS_SCHEMA,
    application_name: `pa-${role}-queue`,
    max: 4,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    migrate: false,
    createSchema: false,
    schedule: false,
    supervise: role === 'worker',
    registerInstance: false,
    persistQueueStats: false,
    persistWarnings: false,
    reindex: false,
  });
}

// pg-boss 12.38.0 schema check failures (contractor.check). Anything else, such as
// an authentication, connection or permission error, is rethrown unchanged.
const SCHEMA_FAILURES = [/^pg-boss is not installed\b/, /^pg-boss database requires migrations$/];

function isSchemaFailure(error: unknown): boolean {
  return error instanceof Error && SCHEMA_FAILURES.some((pattern) => pattern.test(error.message));
}

/** Starts a runtime instance, translating only schema/version failures into a migrator hint. */
export async function startRuntimeBoss(boss: PgBoss): Promise<PgBoss> {
  try {
    return await boss.start();
  } catch (error) {
    await boss.stop({ graceful: false, close: true }).catch(() => undefined);
    throw isSchemaFailure(error) ? new QueueSchemaError(error) : error;
  }
}

/**
 * Enqueues the pilot job inside the caller's transaction, so a rollback removes
 * the job together with the domain row written in the same transaction.
 */
export async function enqueuePilotJob(boss: PgBoss, tx: Transaction, jobId: string, payload: PilotJobPayload): Promise<string> {
  const created = await boss.send(PILOT_QUEUE, payload, { id: jobId, db: fromDrizzle(tx, sql) });
  if (created !== jobId) {
    throw new Error('pg-boss did not create the requested pilot job');
  }
  return created;
}

export async function enqueueCaseJob(boss: PgBoss, tx: Transaction, jobId: string, payload: CaseJobPayload): Promise<void> {
  const created = await boss.send(CASE_QUEUE, payload, { id: jobId, retryLimit: 0, db: fromDrizzle(tx, sql) });
  if (created !== jobId) throw new Error('pg-boss did not create the requested case job');
}

export async function enqueueWorkflowJob(boss: PgBoss, tx: Transaction, jobId: string, requestId: string, revision: number): Promise<void> {
  const created = await boss.send(WORKFLOW_QUEUE, { requestId, revision }, { id: jobId, retryLimit: 0, db: fromDrizzle(tx, sql) });
  if (created !== jobId) throw new Error('pg-boss did not create the requested workflow job');
}

/** Start and resume jobs carry only the run reference; the API holds the scope. */
export async function enqueueAgentJob(boss: PgBoss, tx: Transaction, jobId: string, payload: AgentJobPayload): Promise<void> {
  const created = await boss.send(AGENT_QUEUE, payload, { id: jobId, retryLimit: 0, db: fromDrizzle(tx, sql) });
  if (created !== jobId) throw new Error('pg-boss did not create the requested agent job');
}
