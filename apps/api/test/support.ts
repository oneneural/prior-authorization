import type { FastifyInstance, InjectOptions, LightMyRequestResponse } from 'fastify';

import type { ApiConfig } from '@pa/config';
import { createDatabase, createRuntimeBoss, PILOT_QUEUE, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, withConnection, type TestDatabase } from '@pa/db/testing';

import { buildApi } from '../src/app.js';

export const TEST_TOKEN = 'test-worker-service-token-0123456789abcdef';
export const TEST_ORIGIN = 'http://127.0.0.1:3105';
export type FixtureUser = 'operator' | 'reviewer' | 'outsider';

export interface ApiHarness {
  database: TestDatabase;
  handle: DatabaseHandle;
  apiBoss: PgBoss;
  workerBoss: PgBoss;
  app: FastifyInstance;
  /** `app.inject` as a signed-in fixture user (operator unless a reviewer route or `as` says otherwise). */
  inject(options: string | (InjectOptions & { as?: FixtureUser })): Promise<LightMyRequestResponse>;
  close(): Promise<void>;
}

export function testApiConfig(databaseUrl: string): ApiConfig {
  return {
    appId: 'prior-authorization',
    dataMode: 'fixture',
    agentMode: 'rules',
    authMode: 'fixture',
    logLevel: 'silent',
    databaseUrl,
    workerServiceToken: TEST_TOKEN,
    buildRevision: 'test',
    authSecret: 'test-better-auth-secret-0123456789abcdef',
    publicOrigin: TEST_ORIGIN,
    accountingLedgerFile: null,
    evaluationAdmissionToken: null,
  };
}

/** A migrated database, the API under its own role and a worker-role queue client. */
export async function startApiHarness(): Promise<ApiHarness> {
  const database = await createTestDatabase();
  const handle = createDatabase(database.urls.api, 'pa-api-test');
  const apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  const workerBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  const app = buildApi({ config: testApiConfig(database.urls.api), db: handle.db, boss: apiBoss, logger: false });
  await app.ready();
  const sessions = new Map<FixtureUser, string>();
  const harness: ApiHarness = {
    database,
    handle,
    apiBoss,
    workerBoss,
    app,
    async inject(options) {
      const request = typeof options === 'string' ? { url: options } : options;
      const user = request.as ?? (/\/(reviews|agent-runs\/[^/]+\/review)$/.test(request.url as string) ? 'reviewer' : 'operator');
      // Tests may replace `app` to stand in for a restart; sessions persist in the database.
      if (!sessions.has(user)) sessions.set(user, await signIn(harness.app, user));
      const rest: InjectOptions & { as?: FixtureUser } = { ...request };
      delete rest.as;
      return harness.app.inject({ ...rest, headers: { origin: TEST_ORIGIN, cookie: sessions.get(user)!, ...rest.headers } });
    },
    async close() {
      await app.close();
      await workerBoss.stop({ graceful: false, close: true });
      await apiBoss.stop({ graceful: false, close: true });
      await handle.close();
      await database.drop();
    },
  };
  return harness;
}

/** Reads through the admin role so assertions do not depend on runtime grants. */
export async function adminQuery<T>(database: TestDatabase, text: string, values: unknown[] = []): Promise<T[]> {
  return withConnection(database.urls.admin, async (client) => (await client.query(text, values)).rows as T[]);
}

export async function jobCount(database: TestDatabase, jobId: string): Promise<number> {
  const [row] = await adminQuery<{ count: number }>(database, 'SELECT count(*)::int AS count FROM pgboss.job WHERE id = $1 AND name = $2', [jobId, PILOT_QUEUE]);
  return row?.count ?? 0;
}

export async function probeSnapshot(database: TestDatabase, probeId: string): Promise<unknown> {
  const [row] = await adminQuery(database, 'SELECT * FROM pa_app.pilot_probes WHERE probe_id = $1', [probeId]);
  return row;
}

/** Signs in a seeded fixture user and returns the session cookie header. */
export async function signIn(app: FastifyInstance, user: FixtureUser): Promise<string> {
  const response = await app.inject({ method: 'POST', url: '/api/auth/fixture/sign-in', headers: { origin: TEST_ORIGIN }, payload: { user } });
  if (response.statusCode !== 200) throw new Error(`fixture sign-in failed: ${response.statusCode} ${response.body}`);
  return response.cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join('; ');
}
