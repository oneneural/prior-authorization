import { betterAuth, type BetterAuthPlugin } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { APIError, createAuthEndpoint } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { fromNodeHeaders } from 'better-auth/node';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { ApiConfig } from '@pa/config';
import { ActorRole, FixtureSignInRequest, type FixtureUserKey, type SessionActor } from '@pa/contracts';
import { authSchema, type Database } from '@pa/db';

import { sendError } from '../errors.js';

/** The seeded fixture team that owns every seeded case (the cases' `owner_id`). */
export const FIXTURE_TEAM = 'fixture-operator';

/** Server-owned demo identities. Roles and teams are assigned here, never by a request. */
export const FIXTURE_USERS: Record<FixtureUserKey, { email: string; name: string; role: ActorRole; teamId: string }> = {
  operator: { email: 'operator@fixture.invalid', name: 'Fixture operator', role: 'fixture_operator', teamId: FIXTURE_TEAM },
  reviewer: { email: 'reviewer@fixture.invalid', name: 'Fixture administrative reviewer', role: 'fixture_administrative_reviewer', teamId: FIXTURE_TEAM },
  // Signs in normally but has no case scope; used for cross-case denial.
  outsider: { email: 'outsider@fixture.invalid', name: 'Fixture user outside the case team', role: 'fixture_operator', teamId: 'fixture-other-team' },
};

export type Permission = 'read' | 'assess' | 'request' | 'fixture_event' | 'case_action' | 'agent_run' | 'review_packet' | 'review_agent';
const PERMISSIONS: Record<ActorRole, readonly Permission[]> = {
  fixture_operator: ['read', 'assess', 'request', 'fixture_event', 'case_action', 'agent_run'],
  fixture_administrative_reviewer: ['read', 'review_packet', 'review_agent'],
};

export const SESSION_COOKIE_PREFIX = 'pa';
const SESSION_SECONDS = 8 * 60 * 60;

/**
 * Fixture-mode sign-in by seeded identity key. It exists only because AUTH_MODE
 * is fixture; the session it creates is an ordinary Better Auth session.
 */
const fixtureSignIn = {
  id: 'pa-fixture-sign-in',
  endpoints: {
    fixtureSignIn: createAuthEndpoint('/fixture/sign-in', { method: 'POST', body: FixtureSignInRequest }, async (ctx) => {
      const found = await ctx.context.internalAdapter.findUserByEmail(FIXTURE_USERS[ctx.body.user].email);
      if (found === null) throw new APIError('UNAUTHORIZED', { message: 'fixture user not seeded' });
      const session = await ctx.context.internalAdapter.createSession(found.user.id);
      await setSessionCookie(ctx, { session, user: found.user });
      return ctx.json({ user: { name: found.user.name } });
    }),
  },
} satisfies BetterAuthPlugin;

export function createAuth(config: ApiConfig, db: Database) {
  return betterAuth({
    appName: 'Prior authorization lab',
    baseURL: config.publicOrigin,
    basePath: '/api/auth',
    secret: config.authSecret,
    trustedOrigins: [config.publicOrigin],
    database: drizzleAdapter(db, { provider: 'pg', schema: authSchema }),
    // Accounts are seeded; there is no public registration or password login.
    emailAndPassword: { enabled: false },
    user: {
      additionalFields: {
        role: { type: 'string', required: true, input: false },
        teamId: { type: 'string', required: true, input: false },
      },
    },
    // A fixed 8-hour session from sign-in: the workbench never refreshes the
    // cookie, so a sliding database expiry would only drift from it.
    session: { expiresIn: SESSION_SECONDS, disableSessionRefresh: true },
    advanced: { cookiePrefix: SESSION_COOKIE_PREFIX, defaultCookieAttributes: { sameSite: 'lax', httpOnly: true } },
    // All browser traffic arrives from the one loopback BFF address, so an IP limiter would throttle every user together.
    rateLimit: { enabled: false },
    telemetry: { enabled: false },
    // Credential-free sign-in exists only in fixture mode, which config limits to a loopback origin.
    plugins: config.authMode === 'fixture' ? [fixtureSignIn] : [],
  });
}
export type Auth = ReturnType<typeof createAuth>;

/** Idempotent: creates missing fixture users and never changes existing ones. */
export async function seedFixtureUsers(auth: Auth) {
  const context = await auth.$context;
  for (const user of Object.values(FIXTURE_USERS)) {
    if ((await context.internalAdapter.findUserByEmail(user.email)) === null) {
      await context.internalAdapter.createUser({ ...user, emailVerified: true }, { method: 'admin' });
    }
  }
}

/** Reads the session from the database on every call; there is no cookie cache to trust. */
export async function sessionActor(auth: Auth, headers: FastifyRequest['headers']): Promise<SessionActor | null> {
  const found = await auth.api.getSession({ headers: fromNodeHeaders(headers), query: { disableCookieCache: true } });
  if (found === null) return null;
  const role = ActorRole.safeParse(found.user.role);
  if (!role.success) return null;
  return { userId: found.user.id, name: found.user.name, role: role.data, teamId: found.user.teamId };
}

export function can(actor: SessionActor, permission: Permission): boolean {
  return PERMISSIONS[actor.role].includes(permission);
}

declare module 'fastify' {
  interface FastifyRequest {
    actor: SessionActor | null;
  }
}

export function actorOf(request: FastifyRequest, permission: Permission): SessionActor {
  const actor = request.actor;
  if (actor === null) throw Object.assign(new Error('authentication required'), { statusCode: 401 });
  if (!can(actor, permission)) throw Object.assign(new Error('role not permitted'), { statusCode: 403, permission });
  return actor;
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const SESSION_ROUTES = /^\/api\/(cases|agent)(\/|$)/;

/**
 * Better Auth routes plus the session and origin gates for every browser-facing
 * case and agent route. Identity comes only from the session cookie; identity
 * headers are never read. Mutations must carry the exact trusted Origin.
 */
export function registerAuth(app: FastifyInstance, auth: Auth, config: ApiConfig) {
  app.decorateRequest('actor', null);
  app.addHook('onRequest', async (request, reply) => {
    // The matched route pattern, not the raw URL: the router decodes
    // percent-encoding, so `/api/%63ases/...` must not slip past this gate.
    const route = request.routeOptions.url ?? '';
    const isAuth = route.startsWith('/api/auth/');
    if (!isAuth && !SESSION_ROUTES.test(route)) return;
    if (UNSAFE.has(request.method) && request.headers.origin !== config.publicOrigin) {
      return sendError(reply, 403, 'csrf_rejected', 'Mutations require the trusted origin');
    }
    if (isAuth) return;
    request.actor = await sessionActor(auth, request.headers);
    if (request.actor === null) return sendError(reply, 401, 'unauthorized', 'Sign in required');
  });

  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    async handler(request: FastifyRequest, reply: FastifyReply) {
      const url = new URL(request.url, config.publicOrigin);
      const body = request.method === 'POST' ? JSON.stringify(request.body ?? {}) : undefined;
      const headers = fromNodeHeaders(request.headers);
      if (body !== undefined) headers.set('content-type', 'application/json');
      const response = await auth.handler(new Request(url, { method: request.method, headers, body }));
      reply.code(response.status);
      for (const [name, value] of response.headers) {
        if (name !== 'set-cookie' && name !== 'content-length') reply.header(name, value);
      }
      const cookies = response.headers.getSetCookie();
      if (cookies.length > 0) reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });

  // The workbench's view of the caller: the actor and their demo role only.
  app.get('/api/auth/session-actor', async (request, reply) => {
    const actor = await sessionActor(auth, request.headers);
    if (actor === null) return sendError(reply, 401, 'unauthorized', 'Sign in required');
    return { authMode: 'fixture', actor };
  });
}
