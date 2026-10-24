import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ROLES } from '../src/constants.js';
import { createTestDatabase, withConnection, type TestDatabase } from '../src/testing.js';

const INSUFFICIENT_PRIVILEGE = '42501';

let database: TestDatabase;

beforeAll(async () => {
  database = await createTestDatabase();
});

afterAll(async () => {
  await database?.drop();
});

async function sqlState(connectionString: string, statement: string): Promise<string | undefined> {
  return withConnection(connectionString, async (client) => {
    try {
      await client.query(statement);
      return undefined;
    } catch (error) {
      return (error as { code?: string }).code;
    }
  });
}

// Object-changing statements every runtime role must be refused.
const DDL = [
  'CREATE SCHEMA intruder',
  'CREATE TABLE public.intruder (id int)',
  'CREATE TEMP TABLE intruder (id int)',
  'CREATE TABLE pa_app.intruder (id int)',
  'ALTER TABLE pa_app.pilot_probes ADD COLUMN intruder int',
  'DROP TABLE pa_app.pilot_probes',
  'TRUNCATE pa_app.pilot_probes',
  'CREATE TABLE pa_worker.intruder (id int)',
  'ALTER TABLE pa_worker.worker_heartbeats ADD COLUMN intruder int',
  'DROP TABLE pa_worker.worker_heartbeats',
  'CREATE TABLE pgboss.intruder (id int)',
  'ALTER TABLE pgboss.job ADD COLUMN intruder int',
  'DROP TABLE pgboss.queue',
  'CREATE INDEX intruder ON pgboss.job_common (name)',
  "CREATE FUNCTION public.intruder() RETURNS int LANGUAGE sql AS 'SELECT 1'",
];

describe.each([
  ['API', 'api'],
  ['worker', 'worker'],
] as const)('%s role', (_label, role) => {
  it('has no elevated role attributes', async () => {
    const attributes = await withConnection(database.urls.admin, async (client) => {
      const { rows } = await client.query(
        'SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = $1',
        [ROLES[role]],
      );
      return rows[0] as Record<string, boolean>;
    });
    expect(attributes).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolreplication: false, rolbypassrls: false });
  });

  it.each(DDL)('cannot run: %s', async (statement) => {
    expect(await sqlState(database.urls[role], statement)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it.each([
    "SELECT pgboss.create_queue('intruder', '{}'::jsonb)",
    "SELECT pgboss.delete_queue('pilot-probe')",
    "SELECT pgboss.job_table_format('SELECT 1', 'job_common')",
    "SELECT pgboss.job_table_run('SELECT 1')",
    "SELECT pgboss.job_table_run_async('intruder', 1, 'SELECT 1')",
  ])('cannot execute migration-time queue function: %s', async (statement) => {
    expect(await sqlState(database.urls[role], statement)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('can execute the queue clock function runtime SQL uses (positive control)', async () => {
    expect(await sqlState(database.urls[role], 'SELECT pgboss.job_now()')).toBeUndefined();
  });
});

describe('queue schema functions', () => {
  it('has no SECURITY DEFINER function and no PUBLIC execute grant', async () => {
    const functions = await withConnection(database.urls.admin, async (client) => {
      const { rows } = await client.query<{ proname: string; prosecdef: boolean; public_execute: boolean }>(
        `SELECT proname, prosecdef, has_function_privilege('public', oid, 'EXECUTE') AS public_execute
           FROM pg_proc WHERE pronamespace = 'pgboss'::regnamespace ORDER BY proname`,
      );
      return rows;
    });
    expect(functions.map((row) => row.proname)).toContain('job_now');
    expect(functions.filter((row) => row.prosecdef || row.public_execute)).toEqual([]);
  });
});

describe('application table separation', () => {
  it.each([
    'SELECT * FROM pa_app.pilot_probes',
    "INSERT INTO pa_app.pilot_probes (probe_id, idempotency_key, request_hash, label, job_id) VALUES (gen_random_uuid(), 'k', 'h', 'l', gen_random_uuid())",
    "UPDATE pa_app.pilot_probes SET label = 'x'",
    'DELETE FROM pa_app.pilot_probes',
  ])('worker cannot read or write application data: %s', async (statement) => {
    expect(await sqlState(database.urls.worker, statement)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('API cannot read or write worker heartbeats', async () => {
    expect(await sqlState(database.urls.api, 'SELECT * FROM pa_worker.worker_heartbeats')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('API cannot delete application rows it does not need to delete', async () => {
    expect(await sqlState(database.urls.api, 'DELETE FROM pa_app.pilot_probes')).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('grants exactly the reviewed runtime access (positive control)', async () => {
    expect(await sqlState(database.urls.api, 'SELECT count(*) FROM pa_app.pilot_probes')).toBeUndefined();
    expect(
      await sqlState(
        database.urls.worker,
        "INSERT INTO pa_worker.worker_heartbeats (worker_id, boot_id, started_at, last_seen_at) VALUES ('w', gen_random_uuid(), now(), now())",
      ),
    ).toBeUndefined();
  });
});
