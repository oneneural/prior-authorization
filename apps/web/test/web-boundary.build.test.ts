import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { existsSync } from 'node:fs';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { buildApi, type StreamLifecycleEvent } from '@pa/api';
import { API_HOST, API_PORT } from '@pa/config/topology';
import { CreateProbeResponse, ErrorResponse, LivenessResponse, PILOT_NOTICE, ReadinessResponse, StatusResponse, WORKER_RESULT_PATH } from '@pa/contracts';
import { createDatabase, createRuntimeBoss, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, type TestDatabase } from '@pa/db/testing';

// Exercises the production build from `pnpm build`; the API runs in-process on
// the fixed loopback upstream the web build was compiled against.

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
const TOKEN = 'web-test-worker-service-token-0123456789abcdef';
const FRAMES = 6;
const INTERVAL_MS = 500;
const CANCEL_DEADLINE_MS = 3_000;
const BODY_LIMIT_BYTES = 16 * 1024;

let database: TestDatabase;
let handle: DatabaseHandle;
let boss: PgBoss;
let api: ReturnType<typeof buildApi>;
let web: ChildProcess;
let webOrigin: string;
const streamEvents = new EventEmitter();
const internalHits: string[] = [];
const probePosts: string[] = [];
let apiListening = false;

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') {
    throw new Error('could not allocate a port');
  }
  return address.port;
}

/**
 * Raw HTTP so paths are sent exactly as written, without client-side normalisation.
 * A body given as chunks is sent with chunked transfer encoding and no content-length.
 */
function raw(method: string, path: string, headers: Record<string, string> = {}, body?: string | string[]): Promise<IncomingMessage> {
  const url = new URL(webOrigin);
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: url.hostname, port: url.port, method, path, headers }, resolve);
    req.on('error', reject);
    for (const chunk of typeof body === 'string' ? [body] : (body ?? [])) {
      req.write(chunk);
    }
    req.end();
  });
}

function postProbe(key: string, label: string): Promise<Response> {
  return fetch(`${webOrigin}/api/pilot/probes`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify({ label }),
  });
}

function probeHeaders(contentLength?: number): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json', 'idempotency-key': `web-${randomUUID()}` };
  if (contentLength !== undefined) {
    headers['content-length'] = String(contentLength);
  }
  return headers;
}

async function readBody(response: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of response) {
    body += String(chunk);
  }
  return body;
}

/** Builds the API on the shared database and queue and listens on the fixed upstream port. */
async function startApi(): Promise<void> {
  api = buildApi({
    config: {
      appId: 'prior-authorization',
      dataMode: 'fixture',
      agentMode: 'rules',
      authMode: 'fixture',
      logLevel: 'silent',
      databaseUrl: database.urls.api,
      workerServiceToken: TOKEN,
      buildRevision: 'web-test',
      authSecret: 'web-test-better-auth-secret-0123456789abcdef',
      publicOrigin: 'http://127.0.0.1:3105',
      accountingLedgerFile: null,
      evaluationAdmissionToken: null,
    },
    db: handle.db,
    boss,
    logger: false,
    stream: { frames: FRAMES, intervalMs: INTERVAL_MS },
    events: streamEvents,
  });
  api.addHook('onRequest', (request, _reply, done) => {
    if (request.url.includes('internal')) {
      internalHits.push(request.url);
    }
    if (request.method === 'POST' && request.url === '/api/pilot/probes') {
      probePosts.push(request.headers['content-length'] ?? 'none');
    }
    done();
  });
  await api.listen({ host: API_HOST, port: API_PORT });
  apiListening = true;
}

async function stopApi(): Promise<void> {
  if (apiListening) {
    apiListening = false;
    await api.close();
  }
}

beforeAll(async () => {
  if (!existsSync(new URL('../.next/BUILD_ID', import.meta.url))) {
    throw new Error('apps/web has no production build; run `pnpm build` before `pnpm test:web`');
  }
  database = await createTestDatabase();
  handle = createDatabase(database.urls.api, 'pa-api-web-test');
  boss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  await startApi();

  const port = await freePort();
  webOrigin = `http://127.0.0.1:${port}`;
  web = spawn(process.execPath, [NEXT_BIN, 'start', '--hostname', '127.0.0.1', '--port', String(port)], {
    cwd: WEB_DIR,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1' },
    stdio: 'ignore',
  });
  await waitForWeb();
});

async function waitForWeb(): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) {
      throw new Error(`next start exited with code ${web.exitCode}`);
    }
    const response = await fetch(`${webOrigin}/api/status`).catch(() => undefined);
    if (response?.status === 200) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('next start did not become ready within 60 seconds');
}

afterAll(async () => {
  if (web !== undefined && web.exitCode === null) {
    web.kill('SIGTERM');
    await once(web, 'exit');
  }
  await stopApi();
  await boss?.stop({ graceful: false, close: true });
  await handle?.close();
  await database?.drop();
});

describe('built web server boundary', () => {
  it('serves the labelled status page and the allowlisted status route (positive control)', async () => {
    const status = StatusResponse.parse(await (await fetch(`${webOrigin}/api/status`)).json());
    expect(status.notice).toBe(PILOT_NOTICE);
    expect(status.modes).toEqual({ data: 'fixture', agent: 'rules', agentGraph: 'off', auth: 'fixture' });

    const page = await (await fetch(`${webOrigin}/pilot`)).text();
    expect(page).toContain(PILOT_NOTICE);
    expect(page).toContain('Fixture mode: data fixture, agent rules, agent graph off, identity fixture');
  });

  it('forwards the health routes: liveness without the database, readiness with its reasons', async () => {
    const live = await fetch(`${webOrigin}/api/health/live`);
    expect(live.status).toBe(200);
    expect(LivenessResponse.parse(await live.json())).toEqual({ live: true });

    // No worker reports heartbeats to this in-process API, so it is not ready.
    const ready = await fetch(`${webOrigin}/api/health/ready`);
    expect(ready.status).toBe(503);
    expect(ReadinessResponse.parse(await ready.json()).reasons).toEqual(['worker_heartbeat_missing']);
  });

  it('keeps the pilot notice on the framework not-found page', async () => {
    const response = await fetch(`${webOrigin}/no-such-page`);
    expect(response.status).toBe(404);
    expect(await response.text()).toContain(PILOT_NOTICE);
  });

  it('serves the favicon the page links to, so browsers get no 404', async () => {
    const page = await (await fetch(`${webOrigin}/pilot`)).text();
    expect(page).toMatch(/<link rel="icon" href="\/favicon\.ico(\?[^"]*)?"/);
    const icon = await fetch(`${webOrigin}/favicon.ico`);
    expect(icon.status).toBe(200);
    expect(icon.headers.get('content-type')).toBe('image/x-icon');
    // ICO header: reserved 0, type 1 (icon).
    expect([...new Uint8Array(await icon.arrayBuffer()).subarray(0, 4)]).toEqual([0, 0, 1, 0]);
  });

  it('forwards creation, idempotent replay and conflict through the web origin', async () => {
    const key = `web-${randomUUID()}`;
    const created = await postProbe(key, 'Synthetic web probe');
    expect(created.status).toBe(201);
    const first = CreateProbeResponse.parse(await created.json());
    expect(first).toMatchObject({ replayed: false, probe: { idempotencyKey: key, label: 'Synthetic web probe' } });

    const replayed = await postProbe(key, 'Synthetic web probe');
    expect(replayed.status).toBe(200);
    expect(CreateProbeResponse.parse(await replayed.json())).toMatchObject({ replayed: true, probe: { probeId: first.probe.probeId } });

    const conflict = await postProbe(key, 'A different payload');
    expect(conflict.status).toBe(409);
    expect(ErrorResponse.parse(await conflict.json()).error.code).toBe('idempotency_conflict');

    // The unauthenticated status listing shows the probe but never its idempotency key.
    const statusText = await (await fetch(`${webOrigin}/api/status`)).text();
    const status = StatusResponse.parse(JSON.parse(statusText));
    expect(status.probes.map((probe) => probe.probeId)).toContain(first.probe.probeId);
    expect(statusText).not.toContain(key);
    expect(statusText).not.toContain('idempotencyKey');
  });

  it.each([
    ['a declared content-length', (body: string) => raw('POST', '/api/pilot/probes', probeHeaders(body.length), body)],
    ['chunked transfer with no content-length', (body: string) => raw('POST', '/api/pilot/probes', probeHeaders(), [body.slice(0, 9000), body.slice(9000)])],
  ])('refuses an oversized body with %s before forwarding it', async (_label, send) => {
    probePosts.length = 0;
    const body = JSON.stringify({ label: 'x'.repeat(BODY_LIMIT_BYTES) });
    const response = await send(body);
    expect(response.statusCode).toBe(413);
    expect(ErrorResponse.parse(JSON.parse(await readBody(response))).error.code).toBe('payload_too_large');
    expect(probePosts).toEqual([]);
  });

  it('forwards a chunked body within the limit (positive control)', async () => {
    probePosts.length = 0;
    const body = JSON.stringify({ label: 'Chunked synthetic probe' });
    const response = await raw('POST', '/api/pilot/probes', probeHeaders(), [body.slice(0, 10), body.slice(10)]);
    expect(response.statusCode).toBe(201);
    await readBody(response);
    expect(probePosts).toHaveLength(1);
  });

  it.each([
    ['POST', WORKER_RESULT_PATH],
    ['GET', WORKER_RESULT_PATH],
    ['POST', `/api${WORKER_RESULT_PATH}`],
    ['POST', `/api/..${WORKER_RESULT_PATH}`],
    ['POST', `/api/%2e%2e${WORKER_RESULT_PATH}`],
    ['POST', `/api/pilot/probes/../..${WORKER_RESULT_PATH}`],
    ['POST', `/api/pilot/probes/..%2f..%2f${WORKER_RESULT_PATH.slice(1).replaceAll('/', '%2f')}`],
    ['GET', `/api/status/..%2f..${WORKER_RESULT_PATH}`],
  ])('does not reach the internal worker route via %s %s', async (method, path) => {
    internalHits.length = 0;
    const response = await raw(method, path, { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' });
    const body = await readBody(response);
    expect([404, 405]).toContain(response.statusCode);
    // No API error envelope came back, and the API never saw an internal-route request.
    expect(body).not.toMatch(/"error":\{"code":/);
    expect(internalHits).toEqual([]);
  });

  it('negotiates compression for ordinary responses', async () => {
    const response = await raw('GET', '/pilot', { 'accept-encoding': 'gzip, deflate, br' });
    await readBody(response);
    expect(response.headers['content-encoding']).toBe('gzip');
  });

  it('delivers SSE frames before the stream completes while compression is negotiated', async () => {
    const started = Date.now();
    const response = await raw('GET', '/api/pilot/stream', { accept: 'text/event-stream', 'accept-encoding': 'gzip, deflate, br' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/event-stream');
    expect(response.headers['content-encoding']).toBeUndefined();

    const arrivals: number[] = [];
    let buffer = '';
    for await (const chunk of response) {
      buffer += String(chunk);
      const frames = buffer.match(/^event: frame$/gm)?.length ?? 0;
      while (arrivals.length < frames) {
        arrivals.push(Date.now() - started);
      }
    }
    const completedAt = Date.now() - started;

    expect(arrivals).toHaveLength(FRAMES);
    // Buffering delivers every frame together at completion (gaps near zero). Streaming
    // spreads them about INTERVAL_MS apart; the bounds leave half or more as slack.
    expect(completedAt - arrivals[0]!).toBeGreaterThan(((FRAMES - 1) * INTERVAL_MS) / 2);
    expect(arrivals[1]! - arrivals[0]!).toBeGreaterThan(INTERVAL_MS / 5);
  });

  it('cancels the upstream stream when the browser disconnects', async () => {
    const lifecycle = once(streamEvents, 'stream') as Promise<[StreamLifecycleEvent]>;
    const response = await raw('GET', '/api/pilot/stream', { accept: 'text/event-stream' });
    await new Promise<void>((resolve) => {
      let buffer = '';
      response.on('data', (chunk) => {
        buffer += String(chunk);
        if (buffer.includes('event: frame')) {
          resolve();
        }
      });
    });
    response.destroy();

    const [event] = await Promise.race([
      lifecycle,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error('upstream stream was not cancelled')), CANCEL_DEADLINE_MS)),
    ]);
    expect(event.outcome).toBe('client_closed');
    expect(event.framesSent).toBeLessThan(FRAMES);
  });

});

// Stops the API and restarts it afterwards, so it is independent of test order.
describe('built web server with the API unreachable', () => {
  afterEach(async () => {
    if (!apiListening) {
      await startApi();
    }
  });

  it('reports unknown modes, keeps the notice and accepts nothing when the API is unreachable', async () => {
    await stopApi();

    const page = await (await fetch(`${webOrigin}/pilot`)).text();
    expect(page).toContain(PILOT_NOTICE);
    expect(page).toContain('Mode unknown: data unknown, agent unknown, agent graph unknown, identity unknown (API unavailable)');
    expect(page).not.toContain('Fixture mode:');

    const response = await postProbe(`web-${randomUUID()}`, 'Synthetic web probe');
    expect(response.status).toBe(502);
    expect(ErrorResponse.parse(await response.json()).error.code).toBe('upstream_unavailable');
  });
});
