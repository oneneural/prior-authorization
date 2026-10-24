import { afterEach, describe, expect, it } from 'vitest';

import { PILOT_QUEUE } from '../src/constants.js';
import { runMigrations } from '../src/migrate.js';
import { createRuntimeBoss, QueueSchemaError, startRuntimeBoss } from '../src/queue.js';
import { createTestDatabase, withConnection, type TestDatabase } from '../src/testing.js';

const databases: TestDatabase[] = [];

async function freshDatabase(migrate: boolean): Promise<TestDatabase> {
  const database = await createTestDatabase({ migrate });
  databases.push(database);
  return database;
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.drop()));
});

async function queueSchemaVersion(database: TestDatabase): Promise<number | undefined> {
  return withConnection(database.urls.admin, async (client) => {
    const { rows } = await client.query<{ version: number }>(
      "SELECT version FROM pgboss.version WHERE to_regclass('pgboss.version') IS NOT NULL",
    );
    return rows[0]?.version;
  });
}

describe('runtime queue startup with migrate: false', () => {
  it.each(['api', 'worker'] as const)('%s refuses to start against a missing queue schema and does not install it', async (role) => {
    const database = await freshDatabase(false);
    const boss = createRuntimeBoss(database.urls[role], role);
    boss.on('error', () => undefined);

    const failure = startRuntimeBoss(boss);
    await expect(failure).rejects.toBeInstanceOf(QueueSchemaError);
    await expect(failure).rejects.toThrow(/Queue schema "pgboss" is missing or incompatible .*pg-boss is not installed.*Run the database migrator/);

    const installed = await withConnection(database.urls.admin, async (client) => {
      const { rows } = await client.query("SELECT to_regnamespace('pgboss') IS NOT NULL AS installed");
      return (rows[0] as { installed: boolean }).installed;
    });
    expect(installed).toBe(false);
  });

  it.each(['api', 'worker'] as const)('%s refuses to start against an incompatible schema version and does not migrate it', async (role) => {
    const database = await freshDatabase(true);
    const current = await queueSchemaVersion(database);
    expect(current).toBeGreaterThan(1);
    await withConnection(database.urls.migrator, (client) => client.query('UPDATE pgboss.version SET version = version - 1'));

    const boss = createRuntimeBoss(database.urls[role], role);
    boss.on('error', () => undefined);
    await expect(startRuntimeBoss(boss)).rejects.toThrow(/missing or incompatible .*pg-boss database requires migrations/);
    expect(await queueSchemaVersion(database)).toBe((current ?? 0) - 1);
  });

  it('rethrows an authentication failure unchanged instead of blaming the queue schema', async () => {
    const database = await freshDatabase(true);
    const url = new URL(database.urls.api);
    url.password = 'not-the-api-password';
    const boss = createRuntimeBoss(url.toString(), 'api');
    boss.on('error', () => undefined);

    const error: unknown = await startRuntimeBoss(boss).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).not.toBeInstanceOf(QueueSchemaError);
    expect(error).toMatchObject({ code: '28P01' });
    expect(String(error)).toMatch(/password authentication failed for user "pa_api"/);
    expect(String(error)).not.toMatch(/migrator/);
  });

  it('rethrows a refused connection unchanged instead of blaming the queue schema', async () => {
    const database = await freshDatabase(false);
    const url = new URL(database.urls.worker);
    url.port = '1';
    const boss = createRuntimeBoss(url.toString(), 'worker');
    boss.on('error', () => undefined);

    const error: unknown = await startRuntimeBoss(boss).then(
      () => undefined,
      (failure: unknown) => failure,
    );
    expect(error).not.toBeInstanceOf(QueueSchemaError);
    expect(error).toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('starts against the migrated schema and finds the precreated queue (positive control)', async () => {
    const database = await freshDatabase(true);
    const boss = createRuntimeBoss(database.urls.api, 'api');
    await startRuntimeBoss(boss);
    try {
      expect(await boss.getQueue(PILOT_QUEUE)).toMatchObject({ name: PILOT_QUEUE, policy: 'standard', retryLimit: 3 });
    } finally {
      await boss.stop({ graceful: false, close: true });
    }
  });

  it('re-running the migrator is a no-op that keeps the queue and grants', async () => {
    const database = await freshDatabase(true);
    const version = await queueSchemaVersion(database);
    await runMigrations(database.urls.migrator);
    expect(await queueSchemaVersion(database)).toBe(version);
    const boss = createRuntimeBoss(database.urls.worker, 'worker');
    await startRuntimeBoss(boss);
    await boss.stop({ graceful: false, close: true });
  });
});
