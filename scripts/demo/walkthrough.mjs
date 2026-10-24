// HTTP walkthrough of the packaged demo through the web BFF, as a browser would
// call it (one cookie jar per fixture user, the trusted Origin on mutations).
// scripts/demo/smoke.sh runs it; it needs only Node 24 and the deployment URL.
//
// Usage: node scripts/demo/walkthrough.mjs drive|verify STATE_FILE [--complete-pending]
//   drive   queue, request loop, receipt, response, reassessment, source
//           inspection, packet acceptance, a pending recorded agent run, live
//           refusal and a case cancellation; saves hashes and IDs to STATE_FILE
//   verify  after a restart or restore: the same cases, hashes, receipt and
//           pending work; --complete-pending then finishes the waiting agent run
// Environment: PA_DEMO_ORIGIN (default http://127.0.0.1:3105).
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ORIGIN = process.env.PA_DEMO_ORIGIN ?? 'http://127.0.0.1:3105';
const LOOP = 'case-f02-loop';
const AGENT_CASE = 'case-agent-demo';
const CANCELLED = 'case-f23';
const DEMO_CASES = ['case-f01', 'case-f02', 'case-f08a', 'case-f23', 'case-f28a', LOOP, AGENT_CASE];
const [phase, stateFile, ...flags] = process.argv.slice(2);

const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function check(condition, message, detail) {
  if (!condition) {
    console.error(`walkthrough: FAILED: ${message}${detail === undefined ? '' : ` (${JSON.stringify(detail).slice(0, 400)})`}`);
    process.exit(1);
  }
  console.log(`ok - ${message}`);
}

class Session {
  constructor(name, cookie = '') {
    this.name = name;
    this.cookie = cookie;
  }

  async request(method, path, body) {
    const headers = { ...(this.cookie === '' ? {} : { cookie: this.cookie }), ...(method === 'POST' ? { origin: ORIGIN, 'content-type': 'application/json' } : {}) };
    const response = await fetch(`${ORIGIN}${path}`, { method, headers, redirect: 'manual', body: body === undefined ? undefined : JSON.stringify(body) });
    for (const header of response.headers.getSetCookie()) {
      const [pair] = header.split(';');
      const [name, ...value] = pair.split('=');
      const jar = new Map(this.cookie === '' ? [] : this.cookie.split('; ').map((item) => item.split(/=(.*)/s).slice(0, 2)));
      if (value.join('=') === '' || /max-age=0/i.test(header)) jar.delete(name.trim());
      else jar.set(name.trim(), value.join('='));
      this.cookie = [...jar].map(([key, item]) => `${key}=${item}`).join('; ');
    }
    const text = await response.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* HTML or empty */ }
    return { status: response.status, json, text, location: response.headers.get('location') };
  }

  get(path) { return this.request('GET', path); }
  post(path, body) { return this.request('POST', path, { eventId: randomUUID(), ...body }); }

  async signIn() {
    const response = await this.request('POST', '/api/auth/fixture/sign-in', { user: this.name });
    check(response.status === 200, `fixture ${this.name} signs in`, response.json);
    return this;
  }
}

async function poll(what, read, done, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await read();
    if (done(last)) return last;
    await sleep(500);
  }
  check(false, what, last);
}

/** Rendered text without tags, React text separators or common entities. */
const visibleText = (html) => html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ')
  .replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

const caseView = async (session, caseId) => (await session.get(`/api/cases/${caseId}`)).json;
const workflow = async (session, caseId) => (await session.get(`/api/cases/${caseId}/workflow`)).json;
const settled = (session, caseId, states) => poll(`${caseId} reaches ${states.join(' or ')}`, () => caseView(session, caseId), (view) => states.includes(view?.state));

async function documentHashes(session, caseId) {
  const { documents } = (await session.get(`/api/cases/${caseId}/documents`)).json;
  return Object.fromEntries(documents.map((doc) => [`${doc.documentId}@${doc.version}`, doc.contentHash]).sort());
}

async function queue(session) {
  const response = await session.get('/api/cases');
  check(response.status === 200, 'the signed-in operator reads the case queue', response.json);
  return response.json.cases;
}

async function drive() {
  const anonymous = new Session('anonymous');
  const home = await anonymous.get('/');
  check(home.status === 307 && home.location?.endsWith('/login'), 'an anonymous visitor is sent to the fixture login', home.location);
  check((await anonymous.get('/api/cases')).status === 401, 'case data needs a session');

  const operator = await new Session('operator').signIn();
  const cases = await poll('the seeded queue lists the seven demo cases, all assessed', () => queue(operator),
    (rows) => DEMO_CASES.every((id) => rows.some((row) => row.caseId === id)) && rows.every((row) => !['intake', 'assessing'].includes(row.state)));
  check(cases.length === DEMO_CASES.length, 'the queue holds exactly the seeded synthetic cases', cases.map((row) => row.caseId));
  console.log(`   queue: ${cases.map((row) => `${row.caseId}=${row.state}`).join(', ')}`);
  check(!/approv(al|ed) likelihood|payment approved|authorized for payment/i.test(JSON.stringify(cases)), 'the queue carries no approval or payment wording');

  // The capability is rendered server-side; the BFF exposes no capability route.
  const panel = visibleText((await operator.get(`/cases/${AGENT_CASE}`)).text);
  check(panel.includes('Recorded runs: enabled') && panel.includes('Live Claude: disabled (budget 0)'),
    'the case page shows recorded runs selected explicitly and live Claude disabled at budget 0');
  const agentHead = await caseView(operator, AGENT_CASE);
  const live = await operator.post(`/api/cases/${AGENT_CASE}/agent-runs`, { expectedRevision: agentHead.revision, provider: 'anthropic' });
  check(live.status === 409 && live.json?.error?.code === 'capability_disabled' && live.json.reason === 'live_provider_disabled', 'a live Claude run is refused before any key or client', live.json);

  // Missing-order loop: gap, neutral draft, local approval, simulated receipt.
  const before = await settled(operator, LOOP, ['needs_information']);
  let view = await workflow(operator, LOOP);
  const packet = view.packets.find((item) => !item.superseded).packet;
  const finding = packet.findings.find((item) => item.ruleId === 'R03');
  check(finding !== undefined && finding.status !== 'pass', `${LOOP} reports the missing order gap (R03 ${finding?.status})`);
  const drafted = await operator.post(`/api/cases/${LOOP}/requests`, { ...view.binding, findingId: finding.findingId, templateId: 'existing_order', recipientRole: 'practitioner_records', idempotencyKey: `demo-${randomUUID()}` });
  check(drafted.status === 200 && drafted.json.request.state === 'draft', 'a neutral request for the existing finalized order is drafted', drafted.json);
  const request = drafted.json.request;
  check(!/diagnos|medically necessary|signature:/i.test(request.payload.body), 'the draft requests an existing document and drafts no clinical content');
  const approved = await operator.post(`/api/cases/${LOOP}/requests/${request.requestId}/approve`, { ...view.binding, contentHash: request.contentHash });
  check(approved.status === 200 && approved.json.state === 'approved_local', 'the operator approves the exact draft locally', approved.json);
  view = await poll('the worker records one simulated local delivery', () => workflow(operator, LOOP),
    (item) => item.requests.find((row) => row.requestId === request.requestId)?.state === 'simulated_delivered' && item.receipts.length === 1);
  const receipt = view.receipts[0];
  check(receipt.contentHash === request.contentHash, `local receipt ${receipt.receiptId.slice(0, 8)} matches the approved content hash (${request.contentHash.slice(0, 12)})`);
  console.log(`   adapter proof (scripted_fixture): request ${request.requestId} content ${request.contentHash}; receipt ${receipt.receiptId} mode ${receipt.mode}; nothing transmitted`);

  // Fixture response and reassessment.
  const response = await operator.post(`/api/cases/${LOOP}/fixture-events`, { expectedRevision: before.revision, requestId: request.requestId, fixtureEvent: 'archive_f01' });
  check(response.status === 200 && response.json.disposition === 'reassessment_queued', 'the archived finalized order is recorded as the fixture response', response.json);
  const ready = await settled(operator, LOOP, ['ready_for_review']);
  view = await workflow(operator, LOOP);
  check(ready.revision === before.revision + 1 && view.requests[0].state === 'closed', `reassessment on revision ${ready.revision} reaches ready for administrative review and closes the request`);

  // Source inspection: the exact stored bytes behind the packet.
  const hashes = await documentHashes(operator, LOOP);
  for (const [key, hash] of Object.entries(hashes)) {
    const [documentId, version] = key.split('@');
    const source = await operator.get(`/api/cases/${LOOP}/documents/${documentId}/versions/${version}`);
    if (source.status !== 200) continue;
    check(sha256(source.json.payload) === hash, `source ${key} bytes hash to ${hash.slice(0, 12)}`);
  }
  const policy = (await operator.get(`/api/cases/${LOOP}/policy`)).json;
  check(sha256(policy.policyText) === policy.policyPackSha256 && policy.policyPackSha256 === view.binding.policyPackSha256, `the reviewed local policy pack loads with hash ${policy.policyPackSha256.slice(0, 12)}, as bound to the packet`);
  const current = (await operator.get(`/api/cases/${LOOP}/packet`)).json;
  check(current.packetHash === view.binding.packetHash && current.clinicalReviewStatus === 'requires_qualified_review', `packet ${current.packetHash.slice(0, 12)} is current and still requires qualified clinical review`);

  // Administrative packet acceptance by the reviewer role.
  const reviewer = await new Session('reviewer').signIn();
  const decision = await reviewer.post(`/api/cases/${LOOP}/reviews`, { ...view.binding, decision: 'accept_for_review', reason: 'Administrative evidence reviewed in the synthetic demo.' });
  check(decision.status === 200 && decision.json.clinicalReviewStatus === 'requires_qualified_review', 'the reviewer accepts the packet for administrative review only', decision.json);
  check((await caseView(operator, LOOP)).state === 'accepted_for_review', `${LOOP} is accepted for administrative review (no payer decision)`);

  // A recorded agent run left waiting for review: pending work for restart and restore.
  const started = await operator.post(`/api/cases/${AGENT_CASE}/agent-runs`, { expectedRevision: agentHead.revision, provider: 'recorded', recordingId: 'missing-order-investigation' });
  check(started.status === 202 && started.json.label === 'scripted_fixture', 'the operator starts the separately labelled recorded run', started.json);
  const run = await poll('the recorded run reaches the human review wait', async () => (await operator.get(`/api/cases/${AGENT_CASE}/agent-runs/${started.json.runId}`)).json,
    (item) => item?.run?.state === 'awaiting_review');
  console.log(`   recorded run ${run.run.runId}: ${run.proposals.map((item) => `${item.kind}:${item.status}${item.code === null ? '' : `:${item.code}`}`).join(', ')}`);

  // Cancellation is terminal for the case.
  const target = await settled(operator, CANCELLED, ['needs_information', 'ready_for_review', 'needs_human_review', 'scope_hold']);
  const cancelled = await operator.post(`/api/cases/${CANCELLED}/cancel`, { expectedRevision: target.revision });
  check(cancelled.status === 200 && cancelled.json.state === 'cancelled', `the operator cancels ${CANCELLED}`, cancelled.json);
  const late = await operator.request('POST', `/api/cases/${CANCELLED}/assess`, { expectedRevision: target.revision });
  check(late.status === 409, 'a cancelled case refuses further assessment', late.json);

  const state = {
    operatorCookie: operator.cookie,
    loop: { revision: ready.revision, binding: view.binding, requestId: request.requestId, requestContentHash: request.contentHash, receiptId: receipt.receiptId, documents: hashes },
    agent: { caseId: AGENT_CASE, runId: run.run.runId },
    cancelled: CANCELLED,
    states: Object.fromEntries((await queue(operator)).map((row) => [row.caseId, `${row.state}@${row.revision}`])),
  };
  writeFileSync(stateFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  console.log(`walkthrough: drive complete; state saved for verification`);
}

async function verify() {
  const saved = JSON.parse(readFileSync(stateFile, 'utf8'));
  const operator = new Session('operator', saved.operatorCookie);
  const reused = await operator.get('/api/cases');
  check(reused.status === 200, 'the existing operator session is still valid (sessions live in the database)');
  const rows = await poll('every case is settled', () => queue(operator), (items) => items.every((row) => !['intake', 'assessing'].includes(row.state)));
  const states = Object.fromEntries(rows.map((row) => [row.caseId, `${row.state}@${row.revision}`]));
  check(JSON.stringify(states) === JSON.stringify(saved.states), 'case states and revisions are unchanged and the idempotent seed added nothing', { states, saved: saved.states });

  const view = await workflow(operator, LOOP);
  check(JSON.stringify(view.binding) === JSON.stringify(saved.loop.binding), `packet ${saved.loop.binding.packetHash.slice(0, 12)}, source revision and policy hashes are preserved`);
  check(view.receipts.length === 1 && view.receipts[0].receiptId === saved.loop.receiptId && view.requests[0].contentHash === saved.loop.requestContentHash, 'exactly one local receipt, unchanged');
  check(JSON.stringify(await documentHashes(operator, LOOP)) === JSON.stringify(saved.loop.documents), 'document version hashes are unchanged');
  for (const [key, hash] of Object.entries(saved.loop.documents)) {
    const [documentId, version] = key.split('@');
    const source = await operator.get(`/api/cases/${LOOP}/documents/${documentId}/versions/${version}`);
    if (source.status === 200) check(sha256(source.json.payload) === hash, `source blob ${key} is intact`);
  }
  const run = (await operator.get(`/api/cases/${saved.agent.caseId}/agent-runs/${saved.agent.runId}`)).json;
  check(run.run.state === 'awaiting_review', 'the recorded run is still waiting for its review (pending work preserved)', run.run.state);

  if (flags.includes('--complete-pending')) {
    const reviewer = await new Session('reviewer').signIn();
    const decisions = run.proposals.filter((item) => item.status === 'valid').map((item) => ({ proposalId: item.proposalId, decision: 'accept' }));
    const reviewed = await reviewer.post(`/api/cases/${saved.agent.caseId}/agent-runs/${saved.agent.runId}/review`, { decisions });
    check(reviewed.status === 200, 'the reviewer accepts the valid proposals after the restore', reviewed.json);
    const done = await poll('the restored run resumes from its checkpoint and completes', async () => (await operator.get(`/api/cases/${saved.agent.caseId}/agent-runs/${saved.agent.runId}`)).json,
      (item) => ['completed', 'failed'].includes(item?.run?.state));
    check(done.run.state === 'completed', `the run completed: ${JSON.stringify(done.run.outcome)}`, done.run);
  }
  console.log('walkthrough: verify complete');
}

if (phase === 'drive' && stateFile !== undefined) await drive();
else if (phase === 'verify' && stateFile !== undefined) await verify();
else {
  console.error('usage: node scripts/demo/walkthrough.mjs drive|verify STATE_FILE [--complete-pending]');
  process.exit(2);
}
