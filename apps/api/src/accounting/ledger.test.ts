import { randomUUID } from 'node:crypto';
import { copyFile, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { attemptCeilingUnits, OPUS_5_5_TARIFF } from '@pa/agents/admission';
import type { AttemptReservationRequest, UsageReport } from '@pa/contracts';

import type { DurableStep } from './durable.js';
import { AccountingLedger, AdmissionRefusedError, dayCommitted, LedgerUnavailable, lifetimeCommitted, parseLedger, type LedgerOptions } from './ledger.js';
import { LOCK_FILE_NAME, type ProcessProbe } from './lock.js';
import { MigrationConflict, migrateLedger } from './migrate.js';
import type { LegacyEntry } from './schema.js';

// Offline checks of the canonical accounting ledger (ADR 0001) against the real
// implementation, with disposable directories and synthetic v1 ledgers only.
// No model, key, network or retained ledger is involved.

const CEILING = attemptCeilingUnits(OPUS_5_5_TARIFF, 8192);
const POLICY = { runUnits: 100_000_000, dayUnits: 200_000_000, totalUnits: 200_000_000 };
const worker = { kind: 'worker' as const, id: 'job-1' };
const evaluation = { kind: 'evaluation' as const, id: 'eval-1' };
const versions = { source: 'graph', build: 'test', prompt: 'prompt', tools: 'tools', provider: 'anthropic:test' };
const request = (turn: number, hash = 'a'): AttemptReservationRequest => ({ turn, ordinal: 0, requestHash: hash.repeat(64), model: 'claude-opus-5-5', maxOutputTokens: 8192 });
const usage = (inputTokens = 1000, outputTokens = 100): UsageReport => ({
  usage: { inputTokens, outputTokens, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, cacheWrite1hInputTokens: 0, serverToolRequests: 0, serviceTier: 'standard', inferenceGeo: null },
  providerRequestId: 'req_synthetic', providerMessageId: 'msg_synthetic', model: 'claude-opus-5-5',
});

/** A process identity under test control; `predecessor` says whether a recorded writer stopped. */
const probe = (pid: number, predecessor: 'stopped' | 'running' | 'unknown' = 'running'): ProcessProbe => ({
  identity: () => ({ host: 'test-host', pid, pidNamespace: 'pid:[1]', bootId: 'boot-a' }),
  predecessor: () => predecessor,
});

let clock = new Date('2026-10-22T12:00:00.000Z');
const open: AccountingLedger[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((ledger) => ledger.close().catch(() => undefined)));
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  clock = new Date('2026-10-22T12:00:00.000Z');
});

/** A disposable directory removed after each test. */
async function scratch() {
  const dir = await mkdtemp(join(tmpdir(), 'pa-accounting-'));
  directories.push(dir);
  return dir;
}

/** A reconciled synthetic v1 entry whose actual is recomputed from usage at the recorded tariff. */
function v1Entry(runId: string, day: string, status: LegacyEntry['status'] = 'reconciled', input = 4000, output = 900): LegacyEntry {
  const reconciled = status === 'reconciled';
  return {
    reservationId: randomUUID(), runId, day, createdAt: `${day}T10:00:00.000Z`, model: 'claude-opus-5-5', reservedUsd: 5.1638400000000004,
    actualUsd: reconciled ? (input * 4 + output * 20) / 1e6 : null,
    usage: reconciled ? { inputTokens: input, outputTokens: output, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 } : null, status,
  };
}
const v1 = (entries: LegacyEntry[]) => {
  // Summed in float like the retired ledger, so serialization residue is present.
  const committedUsd = entries.reduce((total, entry) => total + (entry.status === 'reconciled' ? entry.actualUsd! : entry.reservedUsd), 0);
  return `${JSON.stringify({ schemaVersion: 'pa.anthropic-spend.v1', committedUsd, entries }, null, 2)}\n`;
};

async function migrated(entries: LegacyEntry[] = [v1Entry('smoke', '2026-10-21'), v1Entry('full', '2026-10-21')]) {
  const dir = await scratch();
  const path = join(dir, 'ledger.json');
  const retained = join(dir, 'retained-v1.json');
  await writeFile(path, v1(entries));
  await copyFile(path, retained);
  const result = await migrateLedger({ ledgerPath: path, sourceCopy: retained, now: () => clock, probe: probe(1) });
  return { dir, path, retained, result, entries };
}

async function writer(path: string, options: Partial<LedgerOptions> = {}) {
  const ledger = await AccountingLedger.open({ path, caps: POLICY, now: () => clock, probe: probe(100), ...options });
  open.push(ledger);
  return ledger;
}

async function refusal(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AdmissionRefusedError) return error.code;
    if (error instanceof LedgerUnavailable) return `unavailable:${error.reason}`;
    throw error;
  }
  throw new Error('operation was admitted');
}

describe('JSON ledger migration', () => {
  it('keeps every old reservation with original IDs, status, usage and raw values, and holds old open entries in full', async () => {
    const entries = [v1Entry('smoke', '2026-10-21'), v1Entry('full', '2026-10-21'), v1Entry('full', '2026-10-22', 'reserved'), v1Entry('full', '2026-10-22', 'unknown_usage')];
    const { path, result } = await migrated(entries);
    expect(result.outcome).toBe('migrated');
    const ledger = parseLedger(await readFile(path, 'utf8'));
    const actual = 4000 * 40 + 900 * 200;
    expect(result.manifest).toMatchObject({ entries: 4, byStatus: { reserved: 1, reconciled: 2, unknown_usage: 1 }, committedUnits: 2 * actual + 2 * CEILING });
    expect(result.manifest.runs).toEqual({ smoke: actual, full: actual + 2 * CEILING });
    expect(ledger.attempts.map((attempt) => [attempt.attemptId, attempt.state, attempt.imported!.entry])).toEqual(entries.map((entry) => [entry.reservationId, entry.status === 'reconciled' ? 'reconciled' : 'unknown', entry]));
    expect(ledger.runs.every((run) => run.state === 'stopped' && run.callerKind === 'imported')).toBe(true);
    expect(lifetimeCommitted(ledger)).toBe(2 * actual + 2 * CEILING);
  });

  it('is idempotent by source digest and refuses changed, duplicated or missing history', async () => {
    const { path, retained, entries } = await migrated();
    const bytes = await readFile(path);
    expect((await migrateLedger({ ledgerPath: path, sourceCopy: retained, probe: probe(1) })).outcome).toBe('already_migrated');
    expect(await readFile(path)).toEqual(bytes);
    // A different source cannot be replayed over an existing account.
    const changed = join(path, '..', 'changed.json');
    await writeFile(changed, v1([{ ...entries[0]!, actualUsd: entries[0]!.actualUsd! + 0.01 }, entries[1]!]));
    await expect(migrateLedger({ ledgerPath: path, sourceCopy: changed, probe: probe(1) })).rejects.toThrow(MigrationConflict);
    // A v1 ledger that is not byte-identical to the retained copy, or that repeats a reservation ID, is refused.
    const other = await scratch();
    await writeFile(join(other, 'ledger.json'), v1(entries));
    await writeFile(join(other, 'retained.json'), v1([entries[0]!]));
    await expect(migrateLedger({ ledgerPath: join(other, 'ledger.json'), sourceCopy: join(other, 'retained.json'), probe: probe(1) })).rejects.toThrow(/differs from the retained copy/);
    await writeFile(join(other, 'ledger.json'), v1([entries[0]!, entries[0]!]));
    await copyFile(join(other, 'ledger.json'), join(other, 'retained.json'));
    await expect(migrateLedger({ ledgerPath: join(other, 'ledger.json'), sourceCopy: join(other, 'retained.json'), probe: probe(1) })).rejects.toThrow(/duplicate reservation/);
    // Removing imported history breaks the manifest, so the account cannot open.
    const tampered = JSON.parse(bytes.toString('utf8')) as { attempts: unknown[] };
    tampered.attempts.pop();
    await writeFile(path, JSON.stringify(tampered));
    expect(await refusal(writer(path))).toBe('unavailable:invalid');
    await expect(migrateLedger({ ledgerPath: path, sourceCopy: retained, probe: probe(1) })).rejects.toThrow(/missing or extra/);
  });

  it('never initializes an account from nothing', async () => {
    const dir = await scratch();
    await writeFile(join(dir, 'retained.json'), v1([]));
    await expect(migrateLedger({ ledgerPath: join(dir, 'ledger.json'), sourceCopy: join(dir, 'retained.json') })).rejects.toThrow(LedgerUnavailable);
    expect(await refusal(writer(join(dir, 'ledger.json')))).toBe('unavailable:missing');
    expect(await readdir(dir)).toEqual(['retained.json']);
  });
});

describe('opening the canonical ledger', () => {
  it('refuses corrupt files, raised caps and alternate paths, and ignores temporary files', async () => {
    const { dir, path } = await migrated();
    const good = await readFile(path, 'utf8');
    await writeFile(path, `${good.slice(0, 40)}`);
    expect(await refusal(writer(path))).toBe('unavailable:invalid');
    const raised = JSON.parse(good) as { account: { caps: { lifetimeUnits: number } } };
    raised.account.caps.lifetimeUnits = 400_000_000;
    await writeFile(path, JSON.stringify(raised));
    expect(await refusal(writer(path))).toBe('unavailable:invalid');
    await writeFile(path, good);
    // The same account under another name is not a separate, fresh account.
    const alias = join(dir, 'alias.json');
    await symlink(path, alias);
    expect(await refusal(writer(alias))).toBe('unavailable:path_mismatch');
    // A forged temporary file claiming spend headroom is counted, never read.
    const forged = JSON.parse(good) as { attempts: unknown[] };
    forged.attempts = [];
    await writeFile(join(dir, '.ledger.json.forged.tmp'), JSON.stringify(forged));
    const ledger = await writer(path);
    expect(ledger.status()).toMatchObject({ open: true, strayTemporaryFiles: 1, lifetimeCommittedUnits: lifetimeCommitted(parseLedger(good)) });
    expect(await ledger.removeTemporaryFiles()).toBe(1);
  });
});

describe('admission', () => {
  it('admits only fitting reservations under concurrent callers near the run cap', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: CEILING + 1, versions, binding: null, suiteDigest: null, parentRunId: null });
    const results = await Promise.allSettled([0, 1, 2, 3, 4].map((turn) => ledger.reserve('packaged', request(turn), worker)));
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((item) => item.status === 'rejected').map((item) => (item.status === 'rejected' ? (item.reason as AdmissionRefusedError).code : null))).toEqual(Array(4).fill('budget_exhausted'));
    expect(ledger.runSummary('packaged')).toMatchObject({ attempts: 1, runCommittedUnits: CEILING });
  });

  it('applies the UTC-day and lifetime caps across the worker and the evaluation caller', async () => {
    const day = await migrated([]);
    const daily = await writer(day.path, { caps: { ...POLICY, dayUnits: 2 * CEILING + 5 } });
    for (const [runId, callerKind] of [['packaged', 'packaged'], ['eval-1', 'evaluation']] as const) {
      await daily.registerRun({ runId, callerKind, capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    }
    const results = await Promise.allSettled([
      ...[0, 1].map((turn) => daily.reserve('packaged', request(turn), worker)), ...[0, 1].map((turn) => daily.reserve('eval-1', request(turn), evaluation)),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(2);
    expect(daily.status().dayCommittedUnits).toBe(2 * CEILING);

    // USD 18.0605124 of imported spend leaves less than one attempt ceiling of lifetime headroom.
    const spent = await migrated(Array.from({ length: 4 }, () => v1Entry('old', '2026-10-01', 'reconciled', 1_000_000, 25_756)));
    expect(spent.result.manifest.committedUnits).toBe(4 * (40_000_000 + 25_756 * 200));
    const lifetime = await writer(spent.path);
    await lifetime.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    expect(lifetime.status().dayCommittedUnits).toBe(0);
    expect(await refusal(lifetime.reserve('packaged', request(0), worker))).toBe('budget_exhausted');
  });

  it('allows one dispatch project-wide and grants each attempt once', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    await ledger.registerRun({ runId: 'eval-1', callerKind: 'evaluation', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    const a = (await ledger.reserve('packaged', request(0), worker)).attempt;
    const b = (await ledger.reserve('eval-1', request(0), evaluation)).attempt;
    const grants = await Promise.allSettled([ledger.dispatch('packaged', a.attemptId, worker), ledger.dispatch('eval-1', b.attemptId, evaluation)]);
    expect(grants.map((item) => item.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(grants.flatMap((item) => (item.status === 'rejected' ? [(item.reason as AdmissionRefusedError).code] : []))).toEqual(['dispatch_busy']);
    const granted = grants[0].status === 'fulfilled' ? a : b;
    const [runId, owner] = granted === a ? ['packaged', worker] as const : ['eval-1', evaluation] as const;
    expect(await refusal(ledger.dispatch(runId, granted.attemptId, owner))).toBe('dispatch_already_granted');
    expect(await refusal(ledger.dispatch(runId, granted.attemptId, { kind: owner.kind, id: 'someone-else' }))).toBe('attempt_conflict');
    expect(await refusal(ledger.release(runId, granted.attemptId, owner))).toBe('dispatch_already_granted');
  });

  it('replays a lost reservation acknowledgement without a second charge and rejects a changed request', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    const run = { runId: 'packaged', callerKind: 'packaged' as const, capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null };
    await ledger.registerRun(run);
    expect((await ledger.registerRun(run)).runId).toBe('packaged');
    expect(await refusal(ledger.registerRun({ ...run, capUnits: 50_000_000 }))).toBe('attempt_conflict');
    const first = await ledger.reserve('packaged', request(0), worker);
    const again = await ledger.reserve('packaged', request(0), worker);
    expect(again).toMatchObject({ replayed: true, attempt: { attemptId: first.attempt.attemptId } });
    expect(ledger.runSummary('packaged')!.runCommittedUnits).toBe(CEILING);
    expect(await refusal(ledger.reserve('packaged', request(0, 'b'), worker))).toBe('attempt_conflict');
  });

  it('holds unknown billing in full, settles late usage once, and keeps accounting open after the run stops', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    const { attempt } = await ledger.reserve('packaged', request(0), worker);
    await ledger.dispatch('packaged', attempt.attemptId, worker);
    await ledger.markUnknown('packaged', attempt.attemptId, worker);
    await ledger.stopRun('packaged', 'cancelled');
    expect(ledger.status()).toMatchObject({ heldUnknownUnits: CEILING, activeDispatches: 0 });
    // A stopped run gets no new authority, but its late usage still reconciles, exactly and idempotently.
    expect(await refusal(ledger.reserve('packaged', request(1), worker))).toBe('run_stopped');
    const settled = await ledger.reconcile('packaged', attempt.attemptId, usage(), worker);
    expect(settled).toEqual({ attemptId: attempt.attemptId, state: 'reconciled', actualUnits: 1000 * 40 + 100 * 200 });
    expect(await ledger.reconcile('packaged', attempt.attemptId, usage(), worker)).toEqual(settled);
    expect(ledger.runSummary('packaged')).toMatchObject({ runCommittedUnits: 60_000, heldUnits: 0 });
    // Different usage for the same attempt is an integrity incident: kept, and admission stops.
    expect(await refusal(ledger.reconcile('packaged', attempt.attemptId, usage(2000), worker))).toBe('usage_conflict');
    expect(ledger.status()).toMatchObject({ open: false, reason: 'conflicting_usage' });
  });

  it('keeps an over-ceiling actual or an unsupported billing class in full and blocks admission', async () => {
    for (const report of [usage(2_000_000, 8192), { ...usage(), usage: { ...usage().usage, cacheWrite1hInputTokens: 10 } }]) {
      const { path } = await migrated([]);
      const ledger = await writer(path);
      await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
      const { attempt } = await ledger.reserve('packaged', request(0), worker);
      await ledger.dispatch('packaged', attempt.attemptId, worker);
      await ledger.reconcile('packaged', attempt.attemptId, report, worker);
      expect(ledger.status().open).toBe(false);
      expect(ledger.runSummary('packaged')!.runCommittedUnits).toBeGreaterThanOrEqual(CEILING);
      expect(await refusal(ledger.reserve('packaged', request(1), worker))).toBe('admission_blocked');
      await ledger.close();
    }
  });

  it('reconciles a dated snapshot of the requested model and holds a differently priced model', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    const first = (await ledger.reserve('packaged', request(0), worker)).attempt;
    await ledger.dispatch('packaged', first.attemptId, worker);
    const snapshot = await ledger.reconcile('packaged', first.attemptId, { ...usage(), model: 'claude-opus-5-5-20261001' }, worker);
    expect(snapshot).toEqual({ attemptId: first.attemptId, state: 'reconciled', actualUnits: 1000 * 40 + 100 * 200 });
    const recorded = ledger.snapshot().attempts.find((item) => item.attemptId === first.attemptId)!;
    expect([recorded.model, recorded.provider?.model, recorded.incident]).toEqual(['claude-opus-5-5', 'claude-opus-5-5-20261001', null]);
    expect(ledger.status().open).toBe(true);

    const second = (await ledger.reserve('packaged', request(1), worker)).attempt;
    await ledger.dispatch('packaged', second.attemptId, worker);
    expect(await ledger.reconcile('packaged', second.attemptId, { ...usage(), model: 'claude-sonnet-5-5' }, worker)).toMatchObject({ state: 'unknown' });
    expect(ledger.snapshot().attempts.find((item) => item.attemptId === second.attemptId)).toMatchObject({ incident: 'unsupported_billing', reservedUnits: CEILING });
    expect(ledger.status()).toMatchObject({ open: false, reason: 'unsupported_billing' });
  });

  it('carries unsettled liabilities into the new UTC day and counts lifetime once', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    await ledger.registerRun({ runId: 'eval-1', callerKind: 'evaluation', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    clock = new Date('2026-10-22T23:59:59.000Z');
    const { attempt } = await ledger.reserve('packaged', request(0), worker);
    await ledger.dispatch('packaged', attempt.attemptId, worker);
    await ledger.markUnknown('packaged', attempt.attemptId, worker);
    clock = new Date('2026-10-23T00:00:01.000Z');
    await ledger.reserve('eval-1', request(0), evaluation);
    const state = ledger.snapshot();
    expect(state.attempts.find((item) => item.attemptId === attempt.attemptId)!.coveredDays).toEqual(['2026-10-22', '2026-10-23']);
    expect(dayCommitted(state, '2026-10-22')).toBe(CEILING);
    expect(dayCommitted(state, '2026-10-23')).toBe(2 * CEILING);
    expect(lifetimeCommitted(state)).toBe(2 * CEILING);
  });

  it('stops admission when the clock moves backwards until maintenance recovers', async () => {
    const { path } = await migrated([]);
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    await ledger.reserve('packaged', request(0), worker);
    clock = new Date('2026-10-22T11:59:00.000Z');
    expect(await refusal(ledger.reserve('packaged', request(1), worker))).toBe('admission_blocked');
    await ledger.close();
    // The block is persisted: a restarted API is still blocked.
    const restarted = await writer(path);
    expect(restarted.status()).toMatchObject({ open: false, reason: 'clock_regression' });
    await restarted.close();
    const maintenance = await writer(path, { purpose: 'maintenance', confirmedPredecessorStopped: true });
    expect(await maintenance.recover({ clearBlock: true })).toMatchObject({ clearedBlock: 'clock_regression', released: 1 });
    expect(maintenance.status().open).toBe(true);
  });
});

describe('durable writes and writer fencing', () => {
  it('grants nothing from an unconfirmed write at every replacement step', async () => {
    for (const step of ['create', 'write', 'fsync', 'rename', 'dirsync'] as DurableStep[]) {
      const { dir, path } = await migrated([]);
      let failAt: DurableStep | null = null;
      const ledger = await writer(path, { fault: (current) => { if (current === failAt) throw new Error(`injected ${current}`); } });
      await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
      const { attempt } = await ledger.reserve('packaged', request(0), worker);
      const before = await readFile(path, 'utf8');
      failAt = step;
      expect(await refusal(ledger.dispatch('packaged', attempt.attemptId, worker))).toBe(step === 'dirsync' ? 'unavailable:write_uncertain' : 'unavailable:write_failed');
      failAt = null;
      // The failed writer stops for good, including for later healthy writes.
      expect(await refusal(ledger.reserve('packaged', request(1), worker))).toMatch(/^unavailable:/);
      if (step !== 'dirsync') expect(await readFile(path, 'utf8')).toBe(before);
      expect((await readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
      await ledger.close();
      // A restarted writer keeps every persisted liability; if the grant landed it is in flight, never re-granted.
      const restarted = await writer(path);
      const persisted = restarted.snapshot().attempts.find((item) => item.attemptId === attempt.attemptId)!;
      expect(persisted.state).toBe(step === 'dirsync' ? 'dispatching' : 'reserved');
      expect(await refusal(restarted.dispatch('packaged', attempt.attemptId, worker))).toBe(step === 'dirsync' ? 'dispatch_already_granted' : 'admission_blocked');
      expect(restarted.status().lifetimeCommittedUnits).toBe(CEILING);
      await restarted.close();
    }
  });

  it('refuses a second writer, takes over only from a proven-stopped one and fences the old generation', async () => {
    const { path, dir } = await migrated([]);
    const first = await writer(path);
    await first.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    const { attempt } = await first.reserve('packaged', request(0), worker);
    // Same host and namespace with a live holder, or an uninspectable one: no takeover, whatever the lock's age.
    expect(await refusal(writer(path, { probe: probe(200, 'running') }))).toBe('unavailable:writer_lock_held');
    expect(await refusal(writer(path, { probe: probe(200, 'unknown'), now: () => new Date('2027-01-01T00:00:00.000Z') }))).toBe('unavailable:writer_lock_held');
    expect((JSON.parse(await readFile(join(dir, LOCK_FILE_NAME), 'utf8')) as { identity: { pid: number } }).identity.pid).toBe(100);
    // A proven-stopped predecessor is replaced with a new writer generation.
    const second = await writer(path, { probe: probe(200, 'stopped') });
    expect(second.status().writerGeneration).toBe(first.status().writerGeneration + 1);
    expect(await refusal(first.reserve('packaged', request(1), worker))).toBe('unavailable:writer_lock_lost');
    expect(await refusal(second.dispatch('packaged', attempt.attemptId, worker))).toBe('admission_blocked');
    expect(second.status().lifetimeCommittedUnits).toBe(CEILING);
  });

  it('stops when the canonical file is replaced outside the writer, for example by an older copy', async () => {
    const { path } = await migrated([]);
    const older = await readFile(path, 'utf8');
    const ledger = await writer(path);
    await ledger.registerRun({ runId: 'packaged', callerKind: 'packaged', capUnits: 100_000_000, versions, binding: null, suiteDigest: null, parentRunId: null });
    await writeFile(path, older);
    expect(await refusal(ledger.reserve('packaged', request(0), worker))).toBe('unavailable:replaced_externally');
    expect(ledger.status()).toMatchObject({ open: false, failure: 'replaced_externally' });
  });
});
