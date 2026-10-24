import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildApi } from '@pa/api';
import { createCheckpointer, DEFAULT_AGENT_SETTINGS, unavailableLiveClient, type AgentSettings } from '@pa/agents';
import { API_HOST, API_ORIGIN, API_PORT } from '@pa/config/topology';
import type { RevisionBinding } from '@pa/contracts';
import { CHECKPOINT_SCHEMA, createDatabase, createRuntimeBoss, startRuntimeBoss, type DatabaseHandle, type PgBoss } from '@pa/db';
import { createTestDatabase, type TestDatabase } from '@pa/db/testing';
import { startWorker, type RunningWorker } from '@pa/worker';

import { seedDemoCases } from '../../api/src/cases/seed.js';

// The workbench smoke against the production build from `pnpm build`: the
// API and worker run in-process on the fixed loopback upstream, and a cookie
// jar stands in for the browser. It walks seeded login, the four views, the
// missing-order request/response/accept loop, a citation, a stale decision,
// SSE replay and logout, the recorded agent panel, and the negatives.

const WEB_DIR = fileURLToPath(new URL('..', import.meta.url));
const NEXT_BIN = createRequire(import.meta.url).resolve('next/dist/bin/next');
const TOKEN = 'workbench-worker-service-token-0123456789abcdef';
const AUTH_SECRET = `workbench-auth-secret-${randomUUID()}`;
const LOOP = 'case-f02-loop';
const AGENT_CASE = 'case-agent-demo';
const settings: AgentSettings = { ...DEFAULT_AGENT_SETTINGS, graphProvider: 'recorded' };

let database: TestDatabase;
let apiHandle: DatabaseHandle;
let workerHandle: DatabaseHandle;
let apiBoss: PgBoss;
let workerBoss: PgBoss;
let checkpoints: ReturnType<typeof createCheckpointer>;
let api: ReturnType<typeof buildApi>;
let worker: RunningWorker;
let web: ChildProcess;
let webOrigin: string;
const served: string[] = [];

async function freePort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') throw new Error('could not allocate a port');
  return address.port;
}

/** A minimal browser: one cookie jar, same-origin Origin on mutations, no redirects followed. */
class Browser {
  readonly jar = new Map<string, string>();
  lastSetCookies: string[] = [];

  cookie() {
    return [...this.jar].map(([name, value]) => `${name}=${value}`).join('; ');
  }

  async request(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
    const response = await fetch(`${webOrigin}${path}`, {
      method,
      redirect: 'manual',
      headers: { ...(this.jar.size > 0 ? { cookie: this.cookie() } : {}), ...(method === 'POST' ? { origin: webOrigin, 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    this.lastSetCookies = response.headers.getSetCookie();
    for (const header of this.lastSetCookies) {
      const [pair, ...attributes] = header.split(';');
      const [name, ...value] = pair!.split('=');
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute)) || value.join('=') === '';
      if (expired) this.jar.delete(name!.trim());
      else this.jar.set(name!.trim(), value.join('='));
    }
    return response;
  }

  async page(path: string) {
    const response = await this.request('GET', path);
    const html = await response.text();
    served.push(html);
    return { status: response.status, location: response.headers.get('location'), html, text: visibleText(html) };
  }

  async json<T>(method: 'GET' | 'POST', path: string, body?: unknown, headers?: Record<string, string>) {
    const response = await this.request(method, path, body, headers);
    return { status: response.status, body: (await response.json().catch(() => null)) as T };
  }

  signIn(user: 'operator' | 'reviewer' | 'outsider') {
    return this.json('POST', '/api/auth/fixture/sign-in', { user });
  }
}

/** Rendered text without tags, React text separators or common entities. */
function visibleText(html: string) {
  return html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ');
}

interface Workflow { head: { state: string; revision: number }; binding: RevisionBinding | null; requests: { requestId: string; state: string; contentHash: string; payload: RevisionBinding & { body: string } }[] }

async function settled(browser: Browser, caseId: string, state?: string) {
  let last = '';
  await expect.poll(async () => {
    const view = await browser.json<{ state: string }>('GET', `/api/cases/${caseId}`);
    last = view.body.state;
    return state === undefined ? !['intake', 'assessing'].includes(last) : last === state;
  }, { timeout: 30_000, interval: 250 }).toBe(true);
  return last;
}

async function readUntil(reader: ReadableStreamDefaultReader<Uint8Array>, done: (text: string) => boolean, timeoutMs = 10_000) {
  const decoder = new TextDecoder();
  let text = '';
  const timer = setTimeout(() => void reader.cancel(), timeoutMs);
  try {
    while (!done(text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

beforeAll(async () => {
  if (!existsSync(new URL('../.next/BUILD_ID', import.meta.url))) {
    throw new Error('apps/web has no production build; run `pnpm build` before this smoke');
  }
  database = await createTestDatabase();
  apiHandle = createDatabase(database.urls.api, 'pa-api-workbench');
  workerHandle = createDatabase(database.urls.worker, 'pa-worker-workbench');
  apiBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.api, 'api'));
  workerBoss = await startRuntimeBoss(createRuntimeBoss(database.urls.worker, 'worker'));
  checkpoints = createCheckpointer(database.urls.worker, CHECKPOINT_SCHEMA);
  webOrigin = `http://127.0.0.1:${await freePort()}`;

  const core = { appId: 'prior-authorization', dataMode: 'fixture', agentMode: 'rules', authMode: 'fixture', logLevel: 'silent' } as const;
  api = buildApi({
    config: { ...core, databaseUrl: database.urls.api, workerServiceToken: TOKEN, buildRevision: 'workbench-test', authSecret: AUTH_SECRET, publicOrigin: webOrigin, accountingLedgerFile: null, evaluationAdmissionToken: null },
    db: apiHandle.db, boss: apiBoss, logger: false, agent: settings, caseEvents: { pollMs: 200 },
  });
  await api.listen({ host: API_HOST, port: API_PORT });
  worker = await startWorker({
    config: { ...core, databaseUrl: database.urls.worker, workerServiceToken: TOKEN, concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null },
    db: workerHandle.db, boss: workerBoss, apiOrigin: API_ORIGIN, workerId: 'workbench-worker',
    agent: { settings, checkpointer: checkpoints.saver, liveClientFactory: unavailableLiveClient },
  });
  // Trusted fixture ingestion, as an operator seed would do; never a browser route.
  await seedDemoCases(apiHandle.db, apiBoss);

  const port = new URL(webOrigin).port;
  web = spawn(process.execPath, [NEXT_BIN, 'start', '--hostname', '127.0.0.1', '--port', port], {
    cwd: WEB_DIR,
    env: { ...process.env, NODE_ENV: 'production', NEXT_TELEMETRY_DISABLED: '1', PA_PUBLIC_ORIGIN: webOrigin },
    stdio: 'ignore',
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (web.exitCode !== null) throw new Error(`next start exited with code ${web.exitCode}`);
    if ((await fetch(`${webOrigin}/login`).catch(() => undefined))?.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('next start did not become ready');
});

afterAll(async () => {
  if (web !== undefined && web.exitCode === null) {
    web.kill('SIGTERM');
    await once(web, 'exit');
  }
  await worker?.drain(5_000);
  await api?.close();
  await checkpoints?.close();
  await workerBoss?.stop({ graceful: false, close: true });
  await apiBoss?.stop({ graceful: false, close: true });
  await apiHandle?.close();
  await workerHandle?.close();
  await database?.drop();
});

describe('operator workbench', () => {
  const operator = new Browser();
  const reviewer = new Browser();
  let oldBinding: RevisionBinding;

  it('sends an anonymous visitor to the labelled fixture login, then signs in a seeded operator', async () => {
    const anonymous = await operator.page('/');
    expect(anonymous.status).toBe(307);
    expect(anonymous.location).toContain('/login');
    const login = await operator.page('/login');
    expect(login.text).toContain('Fixture identities only (AUTH_MODE=fixture)');
    expect(login.text).toContain('Not a clinical credential');
    expect(login.html).toContain('<html lang="en"');

    expect((await operator.signIn('operator')).status).toBe(200);
    expect(operator.lastSetCookies.some((cookie) => /^pa\.session_token=/.test(cookie) && /HttpOnly/i.test(cookie) && /SameSite=Lax/i.test(cookie))).toBe(true);
    expect((await operator.page('/login')).status).toBe(307);
  });

  it('shows the queue with administrative states, owner and freshness, and no approval wording', async () => {
    for (const caseId of ['case-f01', 'case-f02', LOOP, AGENT_CASE]) await settled(operator, caseId);
    const queue = await operator.page('/');
    expect(queue.status).toBe(200);
    expect(queue.text).toContain('Case queue');
    expect(queue.text).toContain('Fixture operator (demo role)');
    expect(queue.text).toContain('Ready for administrative review (not an authorization)');
    expect(queue.text).toContain('Needs information: administrative documents missing');
    expect(queue.text).toContain('fixture-operator team');
    expect(queue.text).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC/);
    expect(queue.text).not.toMatch(/\bapproved\b|likelihood of approval|\bpaid\b/i);
  });

  it('shows the case workspace and opens a cited extraction at its exact source locator', async () => {
    const workspace = await operator.page(`/cases/${LOOP}`);
    expect(workspace.status).toBe(200);
    for (const text of ['Source documents', 'Requirement matrix', 'Not supplied', 'Requires qualified clinical review', 'Clinical questions and policy limitations', 'Timeline', 'Recorded agent investigation (scripted fixture)', 'Payer authorization and payment: not decided here']) {
      expect(workspace.text).toContain(text);
    }
    const citation = /href="(\/cases\/case-f02-loop\/sources\/[^"]+\?locator=[^"]+)"/.exec(workspace.html);
    expect(citation).not.toBeNull();
    const source = await operator.page(citation![1]!.replace(/&amp;/g, '&'));
    expect(source.status).toBe(200);
    expect(source.html).toContain('data-testid="citation"');
    expect(source.text).toContain('Cited value at /');
  });

  it('drafts, approves and simulates a neutral request, records the fixture response and reassesses', async () => {
    const request = await operator.page(`/cases/${LOOP}/request`);
    expect(request.text).toContain('Prepare neutral draft request for R03');
    expect(request.text).not.toContain('Prepare neutral draft request for R04');
    expect(request.text).toContain('Local simulation only');
    const workflow = (await operator.json<Workflow>('GET', `/api/cases/${LOOP}/workflow`)).body;
    oldBinding = workflow.binding!;
    const detail = (await operator.json<{ assessment: { result: { findings: { findingId: string; ruleId: string }[] } } }>('GET', `/api/cases/${LOOP}`)).body;
    const finding = detail.assessment.result.findings.find((item) => item.ruleId === 'R03')!;
    const drafted = await operator.json('POST', `/api/cases/${LOOP}/requests`, { ...oldBinding, eventId: randomUUID(), idempotencyKey: `smoke-${randomUUID()}`, findingId: finding.findingId, templateId: 'existing_order', recipientRole: 'practitioner_records' });
    expect(drafted.status).toBe(200);
    const preview = await operator.page(`/cases/${LOOP}/request`);
    expect(preview.text).toContain('Please provide the existing finalized order');
    expect(preview.text).toContain('Approve local simulated request');

    const draft = (await operator.json<Workflow>('GET', `/api/cases/${LOOP}/workflow`)).body.requests[0]!;
    const { expectedRevision, sourceRevisionHash, policyPackSha256, packetHash } = draft.payload;
    const approved = await operator.json('POST', `/api/cases/${LOOP}/requests/${draft.requestId}/approve`, { expectedRevision, sourceRevisionHash, policyPackSha256, packetHash, eventId: randomUUID(), contentHash: draft.contentHash });
    expect(approved.status).toBe(200);
    await expect.poll(async () => (await operator.json<Workflow>('GET', `/api/cases/${LOOP}/workflow`)).body.requests[0]!.state, { timeout: 20_000, interval: 250 }).toBe('simulated_delivered');
    expect((await operator.page(`/cases/${LOOP}/request`)).text).toContain('simulated, nothing transmitted');

    const response = await operator.json('POST', `/api/cases/${LOOP}/fixture-events`, { eventId: randomUUID(), expectedRevision: 1, requestId: draft.requestId, fixtureEvent: 'archive_f01' });
    expect(response.status).toBe(200);
    await settled(operator, LOOP, 'ready_for_review');
    expect((await operator.page(`/cases/${LOOP}`)).text).toContain('Ready for administrative review (not an authorization)');
  });

  it('streams ordered durable events, replays after Last-Event-ID and closes the stream on logout', async () => {
    const first = await operator.request('GET', `/api/cases/${LOOP}/events`);
    expect(first.headers.get('content-type')).toContain('text/event-stream');
    const reader = first.body!.getReader();
    const text = await readUntil(reader, (body) => body.includes('assessment_recorded') && /id: \d+[\s\S]*id: \d+[\s\S]*id: \d+/.test(body));
    await reader.cancel();
    const ids = [...text.matchAll(/^id: (\d+)$/gm)].map((match) => Number(match[1]));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(text).not.toMatch(/payloadHash|SYN-BEN|Avery/);

    const resumed = await operator.request('GET', `/api/cases/${LOOP}/events`, undefined, { 'last-event-id': String(ids[0]) });
    const resumedReader = resumed.body!.getReader();
    const replay = await readUntil(resumedReader, (body) => body.includes(`id: ${ids[1]}\n`));
    expect(replay).not.toMatch(new RegExp(`^id: ${ids[0]}$`, 'm'));

    const signOut = await operator.request('POST', '/api/auth/sign-out', {});
    expect(signOut.status).toBe(200);
    // Better Auth clears every session cookie it may have set; each arrives as its own header.
    expect(operator.lastSetCookies.length).toBeGreaterThanOrEqual(2);
    expect(await readUntil(resumedReader, (body) => body.includes('event: revoked'))).toContain('event: revoked');
    expect((await operator.page('/')).status).toBe(307);
    // Jobs are unaffected by stream disconnects: the case stayed at its settled state.
    expect((await reviewer.signIn('reviewer')).status).toBe(200);
    expect((await reviewer.json<{ state: string }>('GET', `/api/cases/${LOOP}`)).body.state).toBe('ready_for_review');
  });

  it('rejects a stale packet decision and records the current one as administrative only', async () => {
    const packet = await reviewer.page(`/cases/${LOOP}/packet`);
    expect(packet.text).toContain('Administrative review only. No payer submission.');
    expect(packet.text).toContain('Fixture administrative reviewer (demo role, not a clinical credential)');
    expect(packet.text).toContain('Included documents');
    expect(packet.text).toContain('Unresolved clinical questions');
    expect(packet.text).toContain('Accept for further review (administrative only)');

    const stale = await reviewer.json<{ error: { code: string } }>('POST', `/api/cases/${LOOP}/reviews`, { ...oldBinding, eventId: randomUUID(), decision: 'accept_for_review', reason: 'Stale preview' });
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('conflict');
    const forbidden = await reviewer.json('POST', `/api/cases/${LOOP}/assess`, { expectedRevision: 2 });
    expect(forbidden.status).toBe(403);

    const binding = (await reviewer.json<Workflow>('GET', `/api/cases/${LOOP}/workflow`)).body.binding!;
    const accepted = await reviewer.json<{ clinicalReviewStatus: string }>('POST', `/api/cases/${LOOP}/reviews`, { ...binding, eventId: randomUUID(), decision: 'accept_for_review', reason: 'Cited administrative facts confirmed' });
    expect(accepted.status).toBe(200);
    expect(accepted.body.clinicalReviewStatus).toBe('requires_qualified_review');
    const after = await reviewer.page(`/cases/${LOOP}/packet`);
    expect(after.text).toContain('Accepted for further review (administrative only, no payer decision)');
    expect(after.text).toContain('Cited administrative facts confirmed');
  });

  it('runs the recorded investigation panel: operator starts, reviewer accepts a valid cited proposal', async () => {
    expect((await operator.signIn('operator')).status).toBe(200);
    const panel = await operator.page(`/cases/${AGENT_CASE}`);
    expect(panel.text).toContain('Recorded runs: enabled. Live Claude: disabled (budget 0).');
    expect(panel.text).toContain('Start recorded run');
    const started = await operator.json<{ runId: string }>('POST', `/api/cases/${AGENT_CASE}/agent-runs`, { eventId: randomUUID(), expectedRevision: 1, provider: 'recorded', recordingId: 'missing-order-investigation' });
    expect(started.status).toBe(202);
    type Run = { run: { state: string }; proposals: { proposalId: string; kind: string; status: string }[] };
    await expect.poll(async () => (await operator.json<Run>('GET', `/api/cases/${AGENT_CASE}/agent-runs/${started.body.runId}`)).body.run.state, { timeout: 30_000, interval: 250 }).toBe('awaiting_review');

    const view = await reviewer.page(`/cases/${AGENT_CASE}`);
    expect(view.text).toContain('Valid against the cited source');
    expect(view.text).toContain('Rejected: below the confidence floor');
    expect(view.text).toContain('Record proposal review');
    expect(view.text).toMatch(/Citation: \S+ version \d+ at \//);
    const run = (await reviewer.json<Run>('GET', `/api/cases/${AGENT_CASE}/agent-runs/${started.body.runId}`)).body;
    const fact = run.proposals.find((item) => item.kind === 'fact' && item.status === 'valid')!;
    const request = run.proposals.find((item) => item.kind === 'request' && item.status === 'valid')!;
    const reviewed = await reviewer.json('POST', `/api/cases/${AGENT_CASE}/agent-runs/${started.body.runId}/review`, { eventId: randomUUID(), decisions: [{ proposalId: fact.proposalId, decision: 'accept' }, { proposalId: request.proposalId, decision: 'reject' }] });
    expect(reviewed.status).toBe(200);
    await expect.poll(async () => (await reviewer.json<Run>('GET', `/api/cases/${AGENT_CASE}/agent-runs/${started.body.runId}`)).body.run.state, { timeout: 30_000, interval: 250 }).toBe('completed');
  });

  it('refuses cross-case access, CSRF, forged identity headers and unlisted paths, and serves no secrets', async () => {
    const outsider = new Browser();
    expect((await outsider.signIn('outsider')).status).toBe(200);
    expect((await outsider.page('/')).html).toContain('data-testid="empty-queue"');
    expect((await outsider.page(`/cases/${LOOP}`)).status).toBe(404);
    expect((await outsider.json('GET', `/api/cases/${LOOP}/workflow`)).status).toBe(404);
    expect((await outsider.json('GET', `/api/cases/${LOOP}/events`)).status).toBe(404);
    expect((await operator.json('GET', `/api/cases/case-f01/documents/f02-encounter/versions/1`)).status).toBe(404);

    const evil = await operator.json<{ error: { code: string } }>('POST', `/api/cases/${LOOP}/assess`, { expectedRevision: 2 }, { origin: 'http://evil.invalid' });
    expect(evil.status).toBe(403);
    expect(evil.body.error.code).toBe('csrf_rejected');
    const noOrigin = await fetch(`${webOrigin}/api/cases/${LOOP}/cancel`, { method: 'POST', headers: { cookie: operator.cookie(), 'content-type': 'application/json' }, body: JSON.stringify({ eventId: randomUUID(), expectedRevision: 2 }) });
    expect(noOrigin.status).toBe(403);
    expect((await new Browser().json('POST', '/api/auth/fixture/sign-in', { user: 'operator' }, { origin: 'http://evil.invalid' })).status).toBe(403);

    const forged = await fetch(`${webOrigin}/api/cases`, { headers: { 'x-actor-id': 'fixture-operator', 'x-user-id': 'operator', 'x-pa-role': 'fixture_operator', authorization: `Bearer ${TOKEN}` } });
    expect(forged.status).toBe(401);
    for (const path of [`/api/cases/${LOOP}/unknown`, `/api/cases/${LOOP}/documents/x/versions/1?locator=/a&other=1`, '/api/cases/..%2finternal', '/api/auth/sign-up/email', '/api/auth/list-sessions']) {
      expect((await operator.request('GET', path)).status, path).toBe(404);
    }

    // Static bundles and every page served in this walkthrough hold no secret or session token.
    const needles = [AUTH_SECRET, TOKEN, new URL(database.urls.api).password, new URL(database.urls.worker).password, operator.jar.get('pa.session_token')!.split('.')[0]!];
    const files: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name));
        else files.push(await readFile(join(dir, entry.name), 'utf8'));
      }
    };
    await walk(join(WEB_DIR, '.next', 'static'));
    for (const content of [...files, ...served]) {
      for (const needle of needles) expect(content.includes(needle)).toBe(false);
      expect(content).not.toMatch(/BETTER_AUTH_SECRET|DATABASE_URL_|WORKER_SERVICE_TOKEN/);
    }
  });
});
