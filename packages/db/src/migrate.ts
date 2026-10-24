import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { PgBoss, type BamStatusSummary } from 'pg-boss';
import pg from 'pg';

import { AGENT_QUEUE, CASE_QUEUE, WORKFLOW_QUEUE } from '@pa/contracts';

import { CHECKPOINT_SCHEMA, MIGRATIONS_SCHEMA, PGBOSS_SCHEMA, PILOT_QUEUE, PILOT_QUEUE_OPTIONS, ROLES } from './constants.js';

// Resolved relative to src/ or dist/; both sit beside the package's migrations and sql folders.
const MIGRATIONS_FOLDER = fileURLToPath(new URL('../migrations', import.meta.url));
const PGBOSS_GRANTS = fileURLToPath(new URL('../sql/pgboss-grants.sql', import.meta.url));

// Serialises concurrent migrator runs against one database.
const MIGRATION_LOCK_KEY = 3_105_000_001;

/** Upper bound for pg-boss background (async) migrations started by a schema upgrade. */
export const ASYNC_MIGRATION_TIMEOUT_MS = 10 * 60 * 1000;

export type MigrationLog = (message: string) => void;

export class AsyncMigrationError extends Error {
  override name = 'AsyncMigrationError';
}

/**
 * Waits until pg-boss reports no pending or running background migration. A
 * schema upgrade can leave index rebuilds and similar commands in `pgboss.bam`,
 * which run only while an instance with `migrate: true` is started; stopping the
 * migrator early would cancel them and leave runtime roles on a partial upgrade.
 * A failed command fails the migration run.
 */
export async function waitForAsyncMigrations(
  status: () => Promise<readonly BamStatusSummary[]>,
  log: MigrationLog,
  options: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (options.timeoutMs ?? ASYNC_MIGRATION_TIMEOUT_MS);
  let reported = false;
  for (;;) {
    const rows = await status();
    const count = (state: BamStatusSummary['status']): number => rows.find((row) => row.status === state)?.count ?? 0;
    if (count('failed') > 0) {
      throw new AsyncMigrationError(`${count('failed')} pg-boss background migration command(s) failed; inspect ${PGBOSS_SCHEMA}.bam`);
    }
    const outstanding = count('pending') + count('in_progress');
    if (outstanding === 0) {
      if (reported) {
        log('queue background migrations finished');
      }
      return;
    }
    if (Date.now() >= deadline) {
      throw new AsyncMigrationError(`${outstanding} pg-boss background migration command(s) did not finish in time`);
    }
    if (!reported) {
      log(`waiting for ${outstanding} queue background migration command(s)`);
      reported = true;
    }
    await delay(options.intervalMs ?? 1_000);
  }
}

async function appliedMigrationCount(client: pg.Client): Promise<number> {
  const { rows } = await client.query<{ table: string | null }>('SELECT to_regclass($1) AS table', [`${MIGRATIONS_SCHEMA}.__drizzle_migrations`]);
  if (rows[0]?.table === null) {
    return 0;
  }
  const result = await client.query<{ count: number }>(`SELECT count(*)::int AS count FROM ${MIGRATIONS_SCHEMA}.__drizzle_migrations`);
  return result.rows[0]?.count ?? 0;
}

/**
 * Installs the pinned LangGraph Postgres checkpoint tables (its own versioned
 * migrations) under the migrator, then gives the worker role data access only.
 */
async function setupCheckpoints(databaseUrl: string): Promise<void> {
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1, application_name: 'pa-migrator-checkpoints' });
  try {
    await new PostgresSaver(pool, undefined, { schema: CHECKPOINT_SCHEMA }).setup();
    await pool.query(`REVOKE ALL ON SCHEMA ${CHECKPOINT_SCHEMA} FROM PUBLIC`);
    await pool.query(`GRANT USAGE ON SCHEMA ${CHECKPOINT_SCHEMA} TO ${ROLES.worker}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${CHECKPOINT_SCHEMA} TO ${ROLES.worker}`);
  } finally {
    await pool.end();
  }
}

/**
 * Runs once, as the schema-owning migrator role, before runtime traffic:
 * reviewed Drizzle migrations, pg-boss schema installation (including any
 * background migrations), pilot queue creation and the reviewed pg-boss grants
 * for the runtime roles. Rerunning it applies only pending migrations.
 */
export async function runMigrations(databaseUrl: string, log: MigrationLog = () => undefined): Promise<void> {
  const client = new pg.Client({ connectionString: databaseUrl, application_name: 'pa-migrator' });
  await client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    try {
      const before = await appliedMigrationCount(client);
      await migrate(drizzle({ client }), { migrationsFolder: MIGRATIONS_FOLDER, migrationsSchema: MIGRATIONS_SCHEMA });
      const after = await appliedMigrationCount(client);
      log(`application migrations: ${after - before} applied, ${after} total`);

      const boss = new PgBoss({
        connectionString: databaseUrl,
        schema: PGBOSS_SCHEMA,
        application_name: 'pa-migrator-queue',
        max: 2,
        migrate: true,
        supervise: false,
        schedule: false,
        registerInstance: false,
      });
      boss.on('error', (error) => log(`pg-boss error during migration: ${error.message}`));
      await boss.start();
      try {
        await waitForAsyncMigrations(() => boss.getBamStatus(), log);
        for (const queue of [PILOT_QUEUE, CASE_QUEUE, WORKFLOW_QUEUE, AGENT_QUEUE]) {
          if ((await boss.getQueue(queue)) === null) {
            await boss.createQueue(queue, PILOT_QUEUE_OPTIONS);
            log(`queue ${queue} created`);
          }
        }
      } finally {
        await boss.stop({ graceful: false, close: true });
      }
      log(`queue schema ${PGBOSS_SCHEMA} installed`);

      await client.query(await readFile(PGBOSS_GRANTS, 'utf8'));
      log('queue grants applied');

      await setupCheckpoints(databaseUrl);
      log(`checkpoint schema ${CHECKPOINT_SCHEMA} installed`);
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]);
    }
  } finally {
    await client.end();
  }
}
