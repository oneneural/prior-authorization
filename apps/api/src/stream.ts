import type { EventEmitter } from 'node:events';

import type { FastifyInstance } from 'fastify';

import type { StreamFrame } from '@pa/contracts';

export interface StreamOptions {
  frames: number;
  intervalMs: number;
}

export const DEFAULT_STREAM: StreamOptions = { frames: 5, intervalMs: 250 };

/** Emitted on the `stream` channel when a fixture stream ends, for transport tests. */
export interface StreamLifecycleEvent {
  outcome: 'completed' | 'client_closed';
  framesSent: number;
}

/**
 * Transport-only SSE fixture: a fixed number of delayed frames with no case or
 * progress data. It proves flushing and disconnect propagation through the web
 * proxy; durable progress events with replay cursors arrive with the workbench.
 */
export function registerStreamFixture(app: FastifyInstance, options: StreamOptions, events?: EventEmitter): void {
  app.get('/api/pilot/stream', (_request, reply) => {
    reply.hijack();
    const response = reply.raw;
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    });
    // An initial comment flushes headers before the first delayed frame.
    response.write(': pilot stream open\n\n');

    let sent = 0;
    let finished = false;
    const finish = (outcome: StreamLifecycleEvent['outcome']): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearInterval(timer);
      events?.emit('stream', { outcome, framesSent: sent } satisfies StreamLifecycleEvent);
    };

    const timer = setInterval(() => {
      sent += 1;
      const frame: StreamFrame = { sequence: sent, total: options.frames, emittedAt: new Date().toISOString() };
      response.write(`id: ${sent}\nevent: frame\ndata: ${JSON.stringify(frame)}\n\n`);
      if (sent >= options.frames) {
        finish('completed');
        response.end();
      }
    }, options.intervalMs);

    // The response closes after a normal end too; `finished` makes that a no-op.
    response.on('close', () => finish('client_closed'));
  });
}
