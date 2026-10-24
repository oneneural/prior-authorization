import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { loadFixture } from '@pa/connectors';

import { buildApi } from '../src/app.js';
import { persistCase } from '../src/cases/service.js';
import { signIn, startApiHarness, TEST_ORIGIN, testApiConfig, type ApiHarness } from './support.js';

let harness: ApiHarness;
let origin: string;
let api: ReturnType<typeof buildApi>;

beforeAll(async () => {
  harness = await startApiHarness();
  await persistCase(harness.handle.db, harness.apiBoss, await loadFixture('F01'));
  api = buildApi({ config: testApiConfig(harness.database.urls.api), db: harness.handle.db, boss: harness.apiBoss, logger: false, caseEvents: { pollMs: 100 } });
  origin = await api.listen({ host: '127.0.0.1', port: 0 });
});
afterAll(async () => {
  await api?.close();
  await harness?.close();
});

it('requires a session, ignores identity headers and refuses cross-origin mutations', async () => {
  expect((await harness.app.inject('/api/cases')).statusCode).toBe(401);
  expect((await harness.app.inject({ url: '/api/cases/case-f01', headers: { 'x-actor-id': 'fixture-operator', 'x-user-id': 'operator', 'x-pa-role': 'fixture_operator' } })).statusCode).toBe(401);
  expect((await harness.app.inject({ method: 'POST', url: '/api/auth/fixture/sign-in', headers: { origin: 'http://evil.invalid' }, payload: { user: 'operator' } })).statusCode).toBe(403);
  const cookie = await signIn(harness.app, 'operator');
  expect((await harness.app.inject({ method: 'POST', url: '/api/cases/case-f01/assess', headers: { cookie }, payload: { expectedRevision: 1 } })).statusCode).toBe(403);
  expect((await harness.app.inject({ method: 'POST', url: '/api/cases/case-f01/assess', headers: { cookie, origin: 'http://evil.invalid' }, payload: { expectedRevision: 1 } })).statusCode).toBe(403);
  const session = await harness.app.inject({ url: '/api/auth/session-actor', headers: { cookie } });
  expect(session.json()).toMatchObject({ authMode: 'fixture', actor: { role: 'fixture_operator', teamId: 'fixture-operator' } });
});

it('gates the routed path, so a percent-encoded case path still meets the origin and session checks', async () => {
  const cookie = await signIn(harness.app, 'operator');
  const encoded = '/api/%63ases/case-f01/assess';
  expect((await harness.app.inject({ method: 'POST', url: encoded, headers: { cookie, origin: 'http://evil.invalid' }, payload: { expectedRevision: 1 } })).json())
    .toMatchObject({ error: { code: 'csrf_rejected' } });
  expect((await harness.app.inject({ method: 'POST', url: encoded, headers: { origin: TEST_ORIGIN }, payload: { expectedRevision: 1 } })).json())
    .toMatchObject({ error: { code: 'unauthorized' } });
  expect((await harness.app.inject({ url: '/api/%63ases' })).json()).toMatchObject({ error: { code: 'unauthorized' } });
});

it('scopes cases by team and roles by action', async () => {
  const outsider = await harness.inject({ url: '/api/cases', as: 'outsider' });
  expect(outsider.json<{ cases: unknown[] }>().cases).toEqual([]);
  expect((await harness.inject({ url: '/api/cases/case-f01', as: 'outsider' })).statusCode).toBe(404);
  expect((await harness.inject({ url: '/api/cases/case-f01/events', as: 'outsider' })).statusCode).toBe(404);
  const listed = (await harness.inject('/api/cases')).json<{ cases: { caseId: string; itemCode: string | null }[] }>().cases;
  expect(listed.map((row) => row.caseId)).toEqual(['case-f01']);
  const approve = await harness.inject({ method: 'POST', url: `/api/cases/case-f01/requests/${randomUUID()}/approve`, as: 'reviewer', payload: {} });
  expect(approve.statusCode).toBe(403);
  expect(approve.json()).toMatchObject({ error: { code: 'forbidden' } });
});

async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, until: (text: string) => boolean, timeoutMs = 5_000) {
  const decoder = new TextDecoder();
  let text = '';
  const deadline = Date.now() + timeoutMs;
  while (!until(text) && Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value);
  }
  return text;
}

it('replays ordered durable events after Last-Event-ID and closes the stream on logout', async () => {
  const cookie = await signIn(api, 'operator');
  const first = await fetch(`${origin}/api/cases/case-f01/events`, { headers: { cookie } });
  const reader = first.body!.getReader();
  const text = await readFrames(reader, (body) => body.includes('assessment_queued'));
  await reader.cancel();
  const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
  expect(ids.length).toBeGreaterThanOrEqual(2);
  expect(ids).toEqual([...ids].sort((a, b) => a - b));
  expect(text).not.toMatch(/payload|policyHash|SYN-/);

  const resumed = await fetch(`${origin}/api/cases/case-f01/events`, { headers: { cookie, 'last-event-id': String(ids[0]) } });
  const resumedReader = resumed.body!.getReader();
  const replay = await readFrames(resumedReader, (body) => body.includes(`id: ${ids[1]}`));
  expect(replay).not.toContain(`id: ${ids[0]}\n`);
  const signOut = await fetch(`${origin}/api/auth/sign-out`, { method: 'POST', headers: { cookie, origin: TEST_ORIGIN, 'content-type': 'application/json' }, body: '{}' });
  expect(signOut.status).toBe(200);
  const rest = await readFrames(resumedReader, (body) => body.includes('event: revoked'));
  expect(rest).toContain('event: revoked');
  expect((await fetch(`${origin}/api/cases`, { headers: { cookie } })).status).toBe(401);
});
