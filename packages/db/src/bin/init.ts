import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';

import { ConfigError, loadProvisionConfig } from '@pa/config';

import { runMigrations } from '../migrate.js';
import { planFromUrls, provisionDatabase } from '../provision.js';

// Bounded one-off step of the Compose deployment (the `init` service): idempotent
// provisioning with the PostgreSQL admin credential, then migrations as the
// migrator role. It never resets data; on an initialised database it reapplies
// role attributes and grants and runs only pending migrations.

const WAIT_FOR_DATABASE_MS = 60_000;

// Connection failures worth retrying while PostgreSQL finishes starting.
const TRANSIENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', '57P03']);

function log(message: string): void {
  console.log(`init: ${message}`);
}

async function waitForDatabase(adminUrl: string): Promise<void> {
  const deadline = Date.now() + WAIT_FOR_DATABASE_MS;
  for (;;) {
    const client = new pg.Client({ connectionString: adminUrl, application_name: 'pa-init', connectionTimeoutMillis: 5_000 });
    try {
      await client.connect();
      await client.end();
      return;
    } catch (error) {
      await client.end().catch(() => undefined);
      const code = (error as { code?: string }).code;
      if (code === undefined || !TRANSIENT.has(code) || Date.now() >= deadline) {
        throw error;
      }
      log(`database not reachable yet (${code}); retrying`);
      await delay(1_000);
    }
  }
}

try {
  const config = loadProvisionConfig();
  const plan = planFromUrls(config);
  await waitForDatabase(config.adminDatabaseUrl);
  const { databaseCreated } = await provisionDatabase(config.adminDatabaseUrl, plan);
  log(databaseCreated ? `created database ${plan.database} and roles` : `database ${plan.database} exists; roles and grants reapplied`);
  await runMigrations(config.migratorDatabaseUrl, (message) => log(message));
  log('complete');
} catch (error) {
  console.error(error instanceof ConfigError ? error.message : `init failed: ${(error as Error).message}`);
  process.exitCode = 1;
}
