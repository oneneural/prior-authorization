import type { FastifyInstance } from 'fastify';

import type { CaseEventFrame } from '@pa/contracts';
import { findCase, listCaseEvents, type Database } from '@pa/db';

import { actorOf, sessionActor, type Auth } from '../auth/index.js';
import { authorizedCase, inScope } from './service.js';

export interface CaseEventStreamOptions {
  /** Poll interval for new durable events and for session/scope revalidation. */
  pollMs: number;
}
export const DEFAULT_CASE_EVENT_STREAM: CaseEventStreamOptions = { pollMs: 1_000 };
const BATCH = 100;

/**
 * Durable, scoped progress: committed case events after the `Last-Event-ID`
 * cursor, in sequence order. Frames carry the event type, actor ID, revision and
 * time only, never payloads. Every poll rechecks the session and case scope and
 * closes the stream with a `revoked` event when either is gone. Closing the
 * stream never touches jobs.
 */
export function registerCaseEventStream(app: FastifyInstance, deps: { db: Database; auth: Auth; options: CaseEventStreamOptions }) {
  app.get<{ Params: { caseId: string } }>('/api/cases/:caseId/events', async (request, reply) => {
    const actor = actorOf(request, 'read');
    const head = await authorizedCase(deps.db, request.params.caseId, actor);
    const header = request.headers['last-event-id'];
    let cursor = typeof header === 'string' && /^\d{1,15}$/.test(header) ? Number(header) : 0;

    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no' });
    response.write(': case events open\n\n');

    let closed = false;
    let timer: NodeJS.Timeout | undefined;
    const close = () => {
      closed = true;
      clearTimeout(timer);
    };
    response.on('close', close);

    const tick = async () => {
      if (closed) return;
      try {
        const current = await sessionActor(deps.auth, request.headers);
        if (current === null || current.userId !== actor.userId || !inScope(await findCase(deps.db, head.caseId), current)) {
          response.write('event: revoked\ndata: {}\n\n');
          close();
          response.end();
          return;
        }
        for (const row of await listCaseEvents(deps.db, head.caseId, cursor, BATCH)) {
          const frame: CaseEventFrame = { sequence: row.sequence, type: row.type, actor: row.actor, inputRevision: row.inputRevision, occurredAt: row.occurredAt.toISOString() };
          response.write(`id: ${row.sequence}\nevent: case_event\ndata: ${JSON.stringify(frame)}\n\n`);
          cursor = row.sequence;
        }
      } catch (error) {
        request.log.warn({ err: { message: (error as Error).message } }, 'case event stream poll failed');
      }
      if (!closed) timer = setTimeout(() => void tick(), deps.options.pollMs);
    };
    await tick();
  });
}
