import type { EventEmitter } from 'node:events';

import Fastify, { type FastifyInstance } from 'fastify';

import { DEFAULT_AGENT_SETTINGS, type AgentSettings } from '@pa/agents/config';
import type { ApiConfig } from '@pa/config';
import {
  CONTRACT_VERSION,
  CreateProbeRequest,
  IDEMPOTENCY_KEY_HEADER,
  IdempotencyKey,
  LIVENESS_PATH,
  PILOT_NOTICE,
  READINESS_PATH,
  StatusResponse,
  type CreateProbeResponse,
  type LivenessResponse,
} from '@pa/contracts';
import { databaseNow, listRecentProbes, type Database, type PgBoss } from '@pa/db';

import { registerEvaluationAdmissionRoutes } from './accounting/routes.js';
import { LiveAdmission } from './accounting/service.js';
import { registerAgentRoutes } from './agent/routes.js';
import { createAuth, registerAuth, seedFixtureUsers } from './auth/index.js';
import { DEFAULT_CASE_EVENT_STREAM, registerCaseEventStream, type CaseEventStreamOptions } from './cases/events.js';
import { registerWorkflowRoutes } from './workflow/routes.js';

import { registerCaseRoutes } from './cases/routes.js';
import { CaseError } from './cases/service.js';

import { sendError } from './errors.js';
import { Health, isDatabaseUnavailable } from './health.js';
import { registerInternalRoutes } from './internal.js';
import { createProbe, idempotencyKeyDigest, toProbeDto, toProbeSummary } from './probes.js';
import { DEFAULT_STREAM, registerStreamFixture, type StreamOptions } from './stream.js';

export { Health } from './health.js';
export { FIXTURE_USERS, SESSION_COOKIE_PREFIX } from './auth/index.js';
export type { StreamLifecycleEvent } from './stream.js';

const RECENT_PROBES = 10;

export interface ApiDependencies {
  config: ApiConfig;
  db: Database;
  boss: PgBoss;
  /** Readiness, heartbeat and drain state; a fresh one is created when omitted. */
  health?: Health;
  /** Pino-compatible logger settings; false disables logging (tests). */
  logger?: boolean | { level: string };
  stream?: StreamOptions;
  /** Receives SSE fixture lifecycle events; used by transport tests. */
  events?: EventEmitter;
  /** Investigation settings; omitted means recorded runs are off and live Claude is disabled. */
  agent?: AgentSettings;
  /** Live accounting, opened by the caller in live mode; omitted means live admission is off. */
  admission?: LiveAdmission;
  caseEvents?: CaseEventStreamOptions;
}

export function buildApi(deps: ApiDependencies): FastifyInstance {
  const app = Fastify({
    logger:
      deps.logger === false
        ? false
        : { level: deps.config.logLevel, redact: ['req.headers.authorization', 'req.headers.cookie'], ...(typeof deps.logger === 'object' ? deps.logger : {}) },
    bodyLimit: 16 * 1024,
  });

  const health = deps.health ?? new Health(deps.db);

  app.setErrorHandler((error, request, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    if (error instanceof CaseError) {
      const code = error.statusCode === 404 ? 'not_found' : error.statusCode === 409 ? 'conflict' : error.statusCode === 503 ? 'shutting_down' : 'invalid_request';
      return sendError(reply, error.statusCode, code, error.message);
    }
    if (status === 401) return sendError(reply, 401, 'unauthorized', 'Sign in required');
    if (status === 403) return sendError(reply, 403, 'forbidden', 'This demo role cannot perform that action');
    if (status !== undefined && status >= 400 && status < 500) {
      return sendError(reply, status, 'invalid_request', 'The request could not be processed');
    }
    if (isDatabaseUnavailable(error)) {
      request.log.warn({ err: { message: (error as Error).message, code: (error as { code?: unknown }).code } }, 'database unavailable');
      return sendError(reply, 503, 'database_unavailable', 'The database is unavailable');
    }
    request.log.error({ err: error }, 'unhandled API error');
    return sendError(reply, 500, 'internal_error', 'Internal error');
  });

  app.setNotFoundHandler((_request, reply) => sendError(reply, 404, 'not_found', 'Not found'));

  // Probed every few seconds by the healthcheck and the watchdog, so successful
  // requests are not logged. Liveness answers from the process alone; it never
  // touches the database.
  const quiet = { logLevel: 'warn' } as const;
  app.get(LIVENESS_PATH, quiet, (_request, reply) => reply.send({ live: true } satisfies LivenessResponse));

  app.get(READINESS_PATH, quiet, async (_request, reply) => {
    const readiness = await health.readiness();
    return reply.code(readiness.ready ? 200 : 503).send(readiness);
  });

  const agent = deps.agent ?? DEFAULT_AGENT_SETTINGS;
  const admission = deps.admission ?? LiveAdmission.disabled(agent);

  app.get('/api/status', async () => {
    const [checkedAt, probes] = await Promise.all([databaseNow(deps.db), listRecentProbes(deps.db, RECENT_PROBES)]);
    return StatusResponse.parse({
      contractVersion: CONTRACT_VERSION,
      appId: deps.config.appId,
      notice: PILOT_NOTICE,
      build: { revision: deps.config.buildRevision },
      modes: { data: deps.config.dataMode, agent: deps.config.agentMode, agentGraph: agent.graphProvider, auth: deps.config.authMode },
      database: { checkedAt: checkedAt.toISOString() },
      probes: probes.map(toProbeSummary),
    });
  });

  app.post('/api/pilot/probes', async (request, reply) => {
    if (health.draining) {
      return sendError(reply, 503, 'shutting_down', 'The application is shutting down and accepts no new submissions');
    }
    const key = IdempotencyKey.safeParse(request.headers[IDEMPOTENCY_KEY_HEADER]);
    if (!key.success) {
      return sendError(reply, 400, 'invalid_idempotency_key', 'An Idempotency-Key header of 16-128 URL-safe characters is required');
    }
    const body = CreateProbeRequest.safeParse(request.body);
    if (!body.success) {
      return sendError(reply, 400, 'invalid_request', 'The probe request is invalid');
    }
    const outcome = await createProbe(deps.db, deps.boss, key.data, body.data);
    request.log.info(
      { outcome: outcome.kind, probeId: outcome.kind === 'conflict' ? undefined : outcome.probe.probeId, keyDigest: idempotencyKeyDigest(key.data) },
      'probe submission',
    );
    if (outcome.kind === 'conflict') {
      return sendError(reply, 409, 'idempotency_conflict', 'This idempotency key was already used with a different payload');
    }
    const response: CreateProbeResponse = {
      contractVersion: CONTRACT_VERSION,
      probe: toProbeDto(outcome.probe),
      replayed: outcome.kind === 'replayed',
    };
    return reply.code(outcome.kind === 'created' ? 201 : 200).send(response);
  });

  // Fixture mode is the only supported AUTH_MODE: seeded users are created before traffic.
  const auth = createAuth(deps.config, deps.db);
  app.addHook('onReady', async () => { await seedFixtureUsers(auth); });
  registerAuth(app, auth, deps.config);
  registerCaseEventStream(app, { db: deps.db, auth, options: deps.caseEvents ?? DEFAULT_CASE_EVENT_STREAM });

  registerWorkflowRoutes(app, { db: deps.db, boss: deps.boss, draining: () => health.draining });
  registerAgentRoutes(app, { db: deps.db, boss: deps.boss, settings: agent, admission, draining: () => health.draining });
  registerCaseRoutes(app, { db: deps.db, boss: deps.boss, draining: () => health.draining });
  registerStreamFixture(app, deps.stream ?? DEFAULT_STREAM, deps.events);
  registerInternalRoutes(app, { db: deps.db, boss: deps.boss, health, workerServiceToken: deps.config.workerServiceToken, agent, admission });
  if (admission.live) registerEvaluationAdmissionRoutes(app, { admission, token: deps.config.evaluationAdmissionToken });

  return app;
}
