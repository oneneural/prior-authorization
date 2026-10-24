import { createHmac, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

import pg from 'pg';

import { ROLES } from './constants.js';
import { runMigrations } from './migrate.js';
import { provisionDatabase } from './provision.js';

// Integration-test support only: disposable databases in the loopback
// PostgreSQL started from compose.test.yaml. It is excluded from the build and
// exported only under the `@pa/source` condition, so runtime code cannot load it.

const DEFAULT_HOST = '127.0.0.1:35105';

/**
 * Makes JSON, util.inspect and Vitest's failure output (pretty-format and loupe)
 * print `shown` instead of the object, so connection URLs and passwords never
 * reach test logs. Property access is unchanged.
 */
function redactWhenPrinted<T extends object>(target: T, shown: unknown): T {
  const print = { value: () => shown, enumerable: false };
  return Object.defineProperties(target, { toJSON: print, [inspect.custom]: print });
}

export interface TestDatabase {
  name: string;
  urls: { admin: string; migrator: string; api: string; worker: string };
  drop(): Promise<void>;
}

function adminUrl(): string {
  const explicit = process.env.PA_TEST_ADMIN_DATABASE_URL;
  if (explicit !== undefined && explicit !== '') {
    return explicit;
  }
  const password = process.env.PA_TEST_POSTGRES_PASSWORD;
  if (password === undefined || password === '') {
    throw new Error('Set PA_TEST_POSTGRES_PASSWORD (or PA_TEST_ADMIN_DATABASE_URL) for integration tests; see docs/development.md');
  }
  return `postgres://postgres:${encodeURIComponent(password)}@${DEFAULT_HOST}/postgres`;
}

function roleUrl(base: string, role: string, password: string, database: string): string {
  const url = new URL(base);
  url.username = role;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

export class TestServerError extends Error {
  override name = 'TestServerError';
}

/**
 * Checks the admin login and refuses to continue while a runtime role is connected
 * to a non-test database. Provisioning resets the cluster-wide role passwords, which
 * would break new connections of a host-process run sharing this server.
 */
async function assertServerFreeForTests(admin: string): Promise<void> {
  const client = new pg.Client({ connectionString: admin, application_name: 'pa-test' });
  try {
    await client.connect();
  } catch (error) {
    if ((error as { code?: unknown }).code === '28P01') {
      throw new TestServerError(
        'The test PostgreSQL rejected PA_TEST_POSTGRES_PASSWORD. Its volume was initialised with another password; ' +
          'run `pnpm db:test:down` (removes the disposable volume) and `pnpm db:test:up` again.',
        { cause: error },
      );
    }
    throw error;
  }
  try {
    const { rows } = await client.query<{ usename: string; datname: string }>(
      `SELECT DISTINCT usename, datname FROM pg_stat_activity
        WHERE usename = ANY($1::text[]) AND datname IS NOT NULL AND datname NOT LIKE 'pa\\_test\\_%'`,
      [Object.values(ROLES)],
    );
    if (rows.length > 0) {
      const sessions = rows.map((row) => `${row.usename}@${row.datname}`).join(', ');
      throw new TestServerError(
        `Runtime roles are connected to non-test databases on the test server (${sessions}). Integration tests reset ` +
          'role passwords; stop the host-process run before running tests.',
      );
    }
  } finally {
    await client.end();
  }
}

/**
 * Creates a uniquely named, provisioned database. Roles are cluster-wide, so
 * their passwords are derived from the admin URL to stay stable across test
 * processes that share the cluster.
 */
export async function createTestDatabase(options: { migrate?: boolean } = {}): Promise<TestDatabase> {
  const admin = adminUrl();
  await assertServerFreeForTests(admin);
  const name = `pa_test_${randomBytes(6).toString('hex')}`;
  const password = (role: string): string => createHmac('sha256', admin).update(role).digest('hex');
  const passwords = { migrator: password(ROLES.migrator), api: password(ROLES.api), worker: password(ROLES.worker) };

  await provisionDatabase(admin, { database: name, passwords });
  const urls = redactWhenPrinted({
    admin: roleUrl(admin, new URL(admin).username, decodeURIComponent(new URL(admin).password), name),
    migrator: roleUrl(admin, ROLES.migrator, passwords.migrator, name),
    api: roleUrl(admin, ROLES.api, passwords.api, name),
    worker: roleUrl(admin, ROLES.worker, passwords.worker, name),
  }, '[redacted connection URLs]');
  if (options.migrate !== false) {
    await runMigrations(urls.migrator);
  }

  const database: TestDatabase = {
    name,
    urls,
    async drop() {
      const client = new pg.Client({ connectionString: admin });
      await client.connect();
      try {
        await client.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(name)} WITH (FORCE)`);
      } finally {
        await client.end();
      }
    },
  };
  return redactWhenPrinted(database, { name, urls: '[redacted connection URLs]' });
}

/** Runs statements as a single role on its own connection and closes it. */
export async function withConnection<T>(connectionString: string, run: (client: pg.Client) => Promise<T>): Promise<T> {
  const client = new pg.Client({ connectionString, application_name: 'pa-test' });
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}
