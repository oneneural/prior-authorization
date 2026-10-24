import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance } from 'fastify';

import {
  CONTRACT_VERSION,
  WORKER_HEARTBEAT_PATH,
  WORKER_RESULT_PATH,
  WorkerHeartbeatReport,
  WorkerResultReport,
  type WorkerResultAck,
} from '@pa/contracts';
import type { Database, PgBoss } from '@pa/db';

import type { AgentSettings } from '@pa/agents/config';

import type { LiveAdmission } from './accounting/service.js';

import { registerAgentInternalRoutes } from './agent/routes.js';
import { registerWorkflowInternalRoutes } from './workflow/routes.js';

import { registerCaseInternalRoutes } from './cases/routes.js';

import { sendError } from './errors.js';
import type { Health } from './health.js';
import { recordWorkerResult, toProbeDto } from './probes.js';

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function bearerToken(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Bearer (\S+)$/.exec(header);
  return match?.[1];
}

export function registerInternalRoutes(app: FastifyInstance, deps: { db: Database; boss: PgBoss; health: Health; workerServiceToken: string; agent: AgentSettings; admission: LiveAdmission }): void {
  const expected = digest(deps.workerServiceToken);

  // The encapsulated plugin scopes the token hook to internal routes only.
  void app.register(
    (internal, _options, done) => {
      internal.addHook('onRequest', async (request, reply) => {
        const presented = bearerToken(request.headers.authorization);
        // Comparing fixed-length digests keeps the check constant-time for any token length.
        if (presented === undefined || !timingSafeEqual(digest(presented), expected)) {
          return sendError(reply, 401, 'unauthorized', 'A valid worker service token is required');
        }
      });

      // Internal routes stay available while the API drains, so the worker can
      // report in-flight results and heartbeats until it has stopped.
      internal.post(WORKER_HEARTBEAT_PATH, { logLevel: 'warn' }, async (request, reply) => {
        const parsed = WorkerHeartbeatReport.safeParse(request.body);
        if (!parsed.success) {
          return sendError(reply, 400, 'invalid_request', 'The worker heartbeat is invalid');
        }
        deps.health.recordHeartbeat(parsed.data);
        return reply.code(204).send();
      });

      internal.post(WORKER_RESULT_PATH, async (request, reply) => {
        const parsed = WorkerResultReport.safeParse(request.body);
        if (!parsed.success) {
          return sendError(reply, 400, 'invalid_request', 'The worker result report is invalid');
        }
        const outcome = await recordWorkerResult(deps.db, deps.boss, parsed.data);
        switch (outcome.kind) {
          case 'reference_mismatch':
            return sendError(reply, 409, 'job_reference_mismatch', 'The job and probe references do not match a persisted job');
          case 'job_not_active':
            return sendError(reply, 409, 'job_not_active', 'The referenced job is not currently claimed by a worker');
          case 'result_conflict':
            return sendError(reply, 409, 'result_conflict', 'A different result was already recorded for this job');
          case 'recorded':
          case 'replayed': {
            const body: WorkerResultAck = {
              contractVersion: CONTRACT_VERSION,
              probe: toProbeDto(outcome.probe),
              replayed: outcome.kind === 'replayed',
            };
            return reply.code(200).send(body);
          }
        }
      });
      registerCaseInternalRoutes(internal, deps);
      registerWorkflowInternalRoutes(internal, deps);
      registerAgentInternalRoutes(internal, { db: deps.db, boss: deps.boss, settings: deps.agent, admission: deps.admission });
      done();
    },
  );
}
