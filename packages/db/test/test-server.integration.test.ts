import { randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import pg from 'pg';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTestDatabase, TestServerError, withConnection, type TestDatabase } from '../src/testing.js';

const databases: TestDatabase[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(databases.splice(0).map((database) => database.drop()));
});

describe('test database harness', () => {
  it('refuses to reset role passwords while a runtime role uses a non-test database', async () => {
    const database = await createTestDatabase({ migrate: false });
    databases.push(database);
    const hostDatabase = `pa_hostrun_${randomBytes(4).toString('hex')}`;
    await withConnection(database.urls.admin, (client) => client.query(`CREATE DATABASE ${pg.escapeIdentifier(hostDatabase)}`));

    const hostUrl = new URL(database.urls.api);
    hostUrl.pathname = `/${hostDatabase}`;
    const hostSession = new pg.Client({ connectionString: hostUrl.toString() });
    await hostSession.connect();
    try {
      const attempt = createTestDatabase({ migrate: false });
      await expect(attempt).rejects.toBeInstanceOf(TestServerError);
      await expect(attempt).rejects.toThrow(`pa_api@${hostDatabase}`);
    } finally {
      await hostSession.end();
      await withConnection(database.urls.admin, (client) =>
        client.query(`DROP DATABASE ${pg.escapeIdentifier(hostDatabase)} WITH (FORCE)`),
      );
    }

    // Positive control: once the host session is gone, provisioning proceeds.
    databases.push(await createTestDatabase({ migrate: false }));
  });

  it('explains a stale test volume when the admin password is rejected', async () => {
    // The same server the suite uses (any test port), with a wrong password.
    const explicit = process.env.PA_TEST_ADMIN_DATABASE_URL;
    const host = explicit === undefined || explicit === '' ? '127.0.0.1:35105' : new URL(explicit).host;
    const wrong = new URL(`postgres://postgres:${randomBytes(8).toString('hex')}@${host}/postgres`);
    vi.stubEnv('PA_TEST_ADMIN_DATABASE_URL', wrong.toString());
    const attempt = createTestDatabase({ migrate: false });
    await expect(attempt).rejects.toBeInstanceOf(TestServerError);
    await expect(attempt).rejects.toThrow(/pnpm db:test:down/);
  });

  it('never prints connection URLs or passwords when a test database is logged or fails an assertion', async () => {
    const database = await createTestDatabase({ migrate: false });
    databases.push(database);
    const secrets = Object.values(database.urls).flatMap((url) => {
      const parsed = new URL(url);
      return [url, decodeURIComponent(parsed.password)];
    });
    expect(secrets.every((secret) => secret.length > 0)).toBe(true);

    const assertions: (() => void | Promise<void>)[] = [
      () => expect(database).toBeNull(),
      () => expect(database).toEqual({}),
      () => expect(database.urls).toBeNull(),
      () => expect(Promise.resolve(database)).rejects.toThrow(),
    ];
    const failures: string[] = [];
    for (const assertion of assertions) {
      try {
        await assertion();
      } catch (error) {
        failures.push(String(error));
      }
    }
    expect(failures).toHaveLength(4);
    const printed = [JSON.stringify(database), inspect(database), inspect(database.urls), ...failures].join('\n');
    for (const secret of secrets) {
      expect(printed.includes(secret)).toBe(false);
    }
    expect(printed).toContain('[redacted connection URLs]');
    // Positive control: the URLs remain usable by the tests.
    await withConnection(database.urls.api, (client) => client.query('SELECT 1'));
  });
});
