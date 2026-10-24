import { API_ORIGIN } from '@pa/config/topology';
import type { ErrorResponse } from '@pa/contracts';

// Request headers the BFF forwards to the API. Authorization, forwarding and
// identity headers are never passed through; the upstream is fixed at build.
// Session routes additionally carry the session cookie and, for mutations, the
// checked Origin.
const FORWARDED_REQUEST_HEADERS = ['accept', 'content-type', 'idempotency-key', 'last-event-id'] as const;
const FORWARDED_RESPONSE_HEADERS = ['content-type', 'cache-control'] as const;

/** Matches the API's Fastify bodyLimit, enforced here before the body is buffered. */
export const MAX_REQUEST_BODY_BYTES = 16 * 1024;

/** Only the API's own session cookies (Better Auth with the `pa` prefix) are forwarded. */
export const SESSION_COOKIE = /^pa\./;

export type AllowedApiPath = '/api/status' | '/api/pilot/probes' | '/api/pilot/stream' | '/api/health/live' | '/api/health/ready';

/** A path built by `caseApiPath` or `authApiPath` from validated segments. */
export type SessionApiPath = string & { readonly __session: unique symbol };

/** The one trusted browser origin; it must equal the API's PA_PUBLIC_ORIGIN. */
export function publicOrigin(): string {
  return process.env.PA_PUBLIC_ORIGIN ?? 'http://127.0.0.1:3105';
}

const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const VERSION = /^[1-9][0-9]{0,8}$/;
const CASE_GET_LEAVES = new Set(['documents', 'policy', 'packet', 'workflow', 'events', 'agent-runs']);
const CASE_POST_LEAVES = new Set(['assess', 'requests', 'reviews', 'fixture-events', 'cancel', 'recover', 'agent-runs']);

/**
 * Maps `/api/cases/<segments>` to the one API route it names, or null. Only the
 * workbench's own reads and commands pass; everything else is a 404 here.
 */
export function caseApiPath(method: string, segments: readonly string[], search: URLSearchParams): SessionApiPath | null {
  if (!segments.every((segment) => SEGMENT.test(segment))) return null;
  const [caseId, leaf, id, action, version] = segments;
  const path = (...parts: string[]) => `/api/cases${parts.map((part) => `/${encodeURIComponent(part)}`).join('')}` as SessionApiPath;
  const noQuery = [...search.keys()].length === 0;
  if (method === 'GET') {
    if (caseId === undefined) return noQuery ? path() : null;
    if (leaf === undefined) return noQuery ? path(caseId) : null;
    if (segments.length === 2 && CASE_GET_LEAVES.has(leaf)) return noQuery ? path(caseId, leaf) : null;
    if (segments.length === 3 && leaf === 'agent-runs' && UUID.test(id!)) return noQuery ? path(caseId, leaf, id!) : null;
    if (segments.length === 5 && leaf === 'documents' && action === 'versions' && VERSION.test(version!)) {
      const keys = [...search.keys()];
      if (keys.some((key) => key !== 'locator') || search.getAll('locator').length > 1) return null;
      const locator = search.get('locator');
      return `${path(caseId, leaf, id!, action, version!)}${locator === null ? '' : `?locator=${encodeURIComponent(locator)}`}` as SessionApiPath;
    }
    return null;
  }
  if (method !== 'POST' || !noQuery || caseId === undefined || leaf === undefined) return null;
  if (segments.length === 2 && CASE_POST_LEAVES.has(leaf)) return path(caseId, leaf);
  if (segments.length === 4 && leaf === 'requests' && UUID.test(id!) && (action === 'approve' || action === 'close')) return path(caseId, leaf, id!, action);
  if (segments.length === 4 && leaf === 'agent-runs' && UUID.test(id!) && (action === 'review' || action === 'cancel')) return path(caseId, leaf, id!, action);
  return null;
}

const AUTH_ROUTES: Record<string, 'GET' | 'POST'> = { 'fixture/sign-in': 'POST', 'sign-out': 'POST', 'get-session': 'GET', 'session-actor': 'GET' };

export function authApiPath(method: string, segments: readonly string[], search: URLSearchParams): SessionApiPath | null {
  const route = segments.join('/');
  return Object.hasOwn(AUTH_ROUTES, route) && AUTH_ROUTES[route] === method && [...search.keys()].length === 0 ? (`/api/auth/${route}` as SessionApiPath) : null;
}

export function notFound(): Response {
  const body: ErrorResponse = { error: { code: 'not_found', message: 'Not found' } };
  return Response.json(body, { status: 404 });
}

function csrfRejected(): Response {
  const body: ErrorResponse = { error: { code: 'csrf_rejected', message: 'Mutations require the trusted origin' } };
  return Response.json(body, { status: 403 });
}

function sessionCookies(request: Request): string | null {
  const pairs = (request.headers.get('cookie') ?? '').split(';').map((pair) => pair.trim()).filter((pair) => SESSION_COOKIE.test(pair));
  return pairs.length === 0 ? null : pairs.join('; ');
}

function pick(source: Headers, names: readonly string[]): Headers {
  const picked = new Headers();
  for (const name of names) {
    const value = source.get(name);
    if (value !== null) {
      picked.set(name, value);
    }
  }
  return picked;
}

export function upstreamUnavailable(): Response {
  const body: ErrorResponse = { error: { code: 'upstream_unavailable', message: 'The API is unavailable' } };
  return Response.json(body, { status: 502 });
}

function unreadableBody(): Response {
  const body: ErrorResponse = { error: { code: 'invalid_request', message: 'The request body could not be read' } };
  return Response.json(body, { status: 400 });
}

function payloadTooLarge(): Response {
  const body: ErrorResponse = { error: { code: 'payload_too_large', message: `Request bodies are limited to ${MAX_REQUEST_BODY_BYTES} bytes` } };
  return Response.json(body, { status: 413 });
}

/**
 * Reads at most MAX_REQUEST_BODY_BYTES. A larger declared length is refused before
 * reading; an undeclared or understated length is counted while streaming.
 */
async function readLimitedBody(request: Request): Promise<Uint8Array<ArrayBuffer> | 'too_large'> {
  const declared = request.headers.get('content-length');
  if (declared !== null && Number(declared) > MAX_REQUEST_BODY_BYTES) {
    return 'too_large';
  }
  if (request.body === null) {
    return new Uint8Array(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > MAX_REQUEST_BODY_BYTES) {
      await reader.cancel();
      return 'too_large';
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Forwards one allowlisted request to the loopback API. The response body is
 * passed through as a stream, and the caller's abort signal cancels the upstream.
 */
export async function forwardToApi(request: Request, path: AllowedApiPath | SessionApiPath, extraResponseHeaders: Record<string, string> = {}, session = false): Promise<Response> {
  const unsafe = request.method !== 'GET' && request.method !== 'HEAD';
  // Checked before the body is read; the API repeats the same check.
  if (session && unsafe && request.headers.get('origin') !== publicOrigin()) {
    return csrfRejected();
  }
  // The body is read before the upstream try, so a client that aborts or breaks
  // its own upload gets a 4xx instead of a report that the API is down.
  let body: Uint8Array<ArrayBuffer> | null = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    let read: Awaited<ReturnType<typeof readLimitedBody>>;
    try {
      read = await readLimitedBody(request);
    } catch {
      return unreadableBody();
    }
    if (read === 'too_large') {
      return payloadTooLarge();
    }
    body = read;
  }
  const headers = pick(request.headers, FORWARDED_REQUEST_HEADERS);
  if (session) {
    const cookie = sessionCookies(request);
    if (cookie !== null) headers.set('cookie', cookie);
    if (unsafe) headers.set('origin', publicOrigin());
  }
  let upstream: Response;
  try {
    upstream = await fetch(new URL(path, API_ORIGIN), {
      method: request.method,
      headers,
      body,
      signal: request.signal,
      cache: 'no-store',
      redirect: 'manual',
    });
  } catch {
    return upstreamUnavailable();
  }
  const responseHeaders = pick(upstream.headers, FORWARDED_RESPONSE_HEADERS);
  for (const [name, value] of Object.entries(extraResponseHeaders)) {
    responseHeaders.set(name, value);
  }
  // Every Set-Cookie is kept separately; joining them would corrupt cookie dates.
  if (session) {
    for (const cookie of upstream.headers.getSetCookie()) responseHeaders.append('set-cookie', cookie);
  }
  return new Response(upstream.body, { status: upstream.status, headers: responseHeaders });
}
