import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile, realpath, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { ACCOUNTING_POLICY, attemptCeilingUnits, OPUS_5_5_TARIFF, tariffCoversModel, unsupportedBilling, usageUnits } from '@pa/agents/admission';
import type { LiveBudgets } from '@pa/agents/config';
import type { AdmissionRefusalCode, AttemptReservationRequest, AttemptSettlement, BudgetRunSummary, RunVersionsRecord, UsageReport } from '@pa/contracts';

import { durableReplace, DurableWriteFailed, isTemporaryName, type FaultHook } from './durable.js';
import { acquireWriterLock, WriterLockUnavailable, type LockRecord, type ProcessProbe, type WriterLock } from './lock.js';
import { LedgerFile, type Attempt, type BudgetRun, type DispatchOwner, type HistoryEntry } from './schema.js';

export type LedgerFailure =
  | 'missing' | 'unreadable' | 'invalid' | 'path_mismatch' | 'writer_lock_held' | 'writer_lock_invalid' | 'writer_lock_lost' | 'writer_lock_io'
  | 'write_failed' | 'write_uncertain' | 'replaced_externally';

/** Accounting cannot be trusted or written. Live admission stops; offline work continues. */
export class LedgerUnavailable extends Error {
  override name = 'LedgerUnavailable';
  constructor(readonly reason: LedgerFailure, message: string) {
    super(message);
  }
}

/** A refused admission operation. No grant exists after it. */
export class AdmissionRefusedError extends Error {
  override name = 'AdmissionRefusedError';
  constructor(readonly code: AdmissionRefusalCode, message: string) {
    super(message);
  }
}

export const sha256 = (text: string | Buffer) => createHash('sha256').update(text).digest('hex');
export const utcDay = (instant: Date) => instant.toISOString().slice(0, 10);
const LIVE_STATES = new Set<Attempt['state']>(['reserved', 'dispatching', 'unknown']);

/** Committed amount of one attempt: a reconciled actual, nothing once released, otherwise the full reservation. */
export function committedUnits(attempt: Attempt): number {
  if (attempt.state === 'reconciled') return attempt.actualUnits ?? attempt.reservedUnits;
  return attempt.state === 'released' ? 0 : attempt.reservedUnits;
}
const sum = (attempts: Iterable<Attempt>) => [...attempts].reduce((total, attempt) => total + committedUnits(attempt), 0);
export const runCommitted = (ledger: LedgerFile, runId: string) => sum(ledger.attempts.filter((item) => item.runId === runId));
/** An attempt counts on every UTC day it covered, so a midnight crossing never releases it. */
export const dayCommitted = (ledger: LedgerFile, day: string) => sum(ledger.attempts.filter((item) => item.coveredDays.includes(day)));
export const lifetimeCommitted = (ledger: LedgerFile) => sum(ledger.attempts);

/**
 * Integrity beyond the schema. Derived totals are recomputed from complete
 * entries, never trusted. Any problem makes the file unusable for admission.
 */
export function integrityProblems(ledger: LedgerFile): string[] {
  const problems: string[] = [];
  const runIds = new Set<string>();
  for (const run of ledger.runs) {
    if (runIds.has(run.runId)) problems.push(`duplicate run ${run.runId}`);
    runIds.add(run.runId);
  }
  const attemptIds = new Set<string>();
  const slots = new Set<string>();
  for (const attempt of ledger.attempts) {
    if (attemptIds.has(attempt.attemptId)) problems.push(`duplicate attempt ${attempt.attemptId}`);
    attemptIds.add(attempt.attemptId);
    if (!runIds.has(attempt.runId)) problems.push(`attempt ${attempt.attemptId} names an unknown run`);
    if (attempt.imported === null) {
      const slot = `${attempt.runId}:${attempt.turn}:${attempt.ordinal}`;
      if (slots.has(slot)) problems.push(`duplicate attempt slot ${slot}`);
      slots.add(slot);
    }
    const reconciled = attempt.state === 'reconciled';
    if (reconciled !== (attempt.actualUnits !== null) || (reconciled && attempt.usage === null && attempt.imported === null)) problems.push(`attempt ${attempt.attemptId} has an incomplete reconciliation`);
    if (attempt.state === 'dispatching' && (attempt.owner === null || attempt.dispatchedAt === null)) problems.push(`attempt ${attempt.attemptId} is dispatching without an owner`);
    if (attempt.writerGeneration > ledger.writerGeneration) problems.push(`attempt ${attempt.attemptId} is from a future writer generation`);
    const days = attempt.coveredDays;
    if (days.some((day, index) => index > 0 && day <= days[index - 1]!)) problems.push(`attempt ${attempt.attemptId} has unordered days`);
  }
  if (ledger.attempts.filter((item) => item.state === 'dispatching').length > ACCOUNTING_POLICY.maxActiveDispatches) problems.push('more active dispatches than the policy allows');
  ledger.history.forEach((entry, index) => { if (entry.seq !== index + 1) problems.push('history sequence is not contiguous'); });
  const manifest = ledger.account.migration;
  const imported = ledger.attempts.filter((item) => item.imported !== null);
  if (imported.length !== manifest.entries) problems.push('imported entries differ from the migration manifest');
  if (sum(imported) !== manifest.committedUnits) problems.push('imported total differs from the migration manifest');
  for (const [runId, units] of Object.entries(manifest.runs)) if (sum(imported.filter((item) => item.runId === runId)) !== units) problems.push(`imported run ${runId} differs from the manifest`);
  for (const [day, units] of Object.entries(manifest.days)) if (sum(imported.filter((item) => item.coveredDays[0] === day)) !== units) problems.push(`imported day ${day} differs from the manifest`);
  return [...new Set(problems)];
}

export function parseLedger(text: string): LedgerFile {
  let ledger: LedgerFile;
  try {
    ledger = LedgerFile.parse(JSON.parse(text));
  } catch {
    throw new LedgerUnavailable('invalid', 'the accounting ledger failed schema validation');
  }
  const problems = integrityProblems(ledger);
  if (problems.length > 0) throw new LedgerUnavailable('invalid', `the accounting ledger failed integrity validation (${problems.length} problem(s))`);
  return ledger;
}

export const serializeLedger = (ledger: LedgerFile) => `${JSON.stringify(ledger, null, 2)}\n`;

/** Serializes in-process admission mutations. Cross-process exclusion is the writer lock. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(task: () => Promise<T>): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

type Outcome<T> = { value: T } | { refuse: AdmissionRefusedError };

export interface LedgerOptions {
  /** The configured canonical path; it must equal the path recorded at migration. */
  path: string;
  /** Configured caps, at most the fixed policy. */
  caps: LiveBudgets;
  purpose?: LockRecord['purpose'];
  now?: () => Date;
  probe?: ProcessProbe;
  fault?: FaultHook;
  /** Maintenance only: an operator confirmed the previous writer stopped. */
  confirmedPredecessorStopped?: boolean;
}

export interface AdmissionStatus {
  open: boolean;
  /** Persisted integrity stop or in-process failure; null when open. */
  reason: string | null;
  /** The in-process failure alone: the ledger cannot be written by this API. */
  failure: LedgerFailure | null;
  writerGeneration: number;
  day: string;
  dayCommittedUnits: number;
  lifetimeCommittedUnits: number;
  remaining: { dayUnits: number; lifetimeUnits: number };
  activeDispatches: number;
  heldUnknownUnits: number;
  strayTemporaryFiles: number;
}

export interface RegisterRunInput {
  runId: string;
  callerKind: 'packaged' | 'evaluation';
  capUnits: number;
  versions: RunVersionsRecord;
  binding: BudgetRun['binding'];
  suiteDigest: string | null;
  parentRunId: string | null;
}

/**
 * The canonical accounting ledger, owned by exactly one API process. Every
 * mutation runs under the in-process mutex and the writer lock, rereads and
 * revalidates the complete file, checks that nobody replaced it since this
 * writer's last confirmed write, computes the next full ledger and replaces it
 * durably. Any failed or ambiguous write stops admission for this process.
 */
export class AccountingLedger {
  private readonly mutex = new Mutex();
  private failure: LedgerUnavailable | null = null;
  private strayTemporaryFiles = 0;

  private constructor(
    private readonly realPath: string,
    private readonly lock: WriterLock,
    private state: LedgerFile,
    private lastSha: string,
    private readonly options: LedgerOptions,
  ) {}

  static async open(options: LedgerOptions): Promise<AccountingLedger> {
    let realPath: string;
    try {
      realPath = await realpath(options.path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new LedgerUnavailable('missing', 'the canonical accounting ledger does not exist; live startup never creates one');
      throw new LedgerUnavailable('unreadable', 'the canonical accounting ledger could not be resolved');
    }
    let lock: WriterLock;
    try {
      lock = await acquireWriterLock({ ledgerPath: realPath, purpose: options.purpose ?? 'api', probe: options.probe, now: options.now, confirmedPredecessorStopped: options.confirmedPredecessorStopped });
    } catch (error) {
      if (error instanceof WriterLockUnavailable) throw new LedgerUnavailable(error.reason, error.message);
      throw error;
    }
    try {
      let text: string;
      try {
        text = await readFile(realPath, 'utf8');
      } catch {
        throw new LedgerUnavailable('unreadable', 'the canonical accounting ledger could not be read');
      }
      const ledger = parseLedger(text);
      if (ledger.account.ledgerPath !== options.path) throw new LedgerUnavailable('path_mismatch', 'the ledger was migrated for a different configured path; an alternate location is not a separate account');
      const instance = new AccountingLedger(realPath, lock, ledger, sha256(text), options);
      instance.strayTemporaryFiles = (await readdir(dirname(realPath)).catch(() => [])).filter((name) => isTemporaryName(realPath, name)).length;
      // A fresh writer generation fences every reservation of the previous writer.
      await instance.mutate<void>((draft, now) => {
        draft.writerGeneration += 1;
        instance.history(draft, now, 'writer_acquired', null, null, `${options.purpose ?? 'api'}${lock.replaced === null ? '' : ':replaced_stopped_writer'}`);
        return { value: undefined };
      });
      return instance;
    } catch (error) {
      await lock.release().catch(() => undefined);
      throw error;
    }
  }

  private now() {
    return (this.options.now ?? (() => new Date()))();
  }

  private history(draft: LedgerFile, now: Date, kind: HistoryEntry['kind'], runId: string | null, attemptId: string | null, detail: string | null = null) {
    draft.history.push({ seq: draft.history.length + 1, at: now.toISOString(), generation: draft.writerGeneration, kind, runId, attemptId, detail });
  }

  private fail(reason: LedgerFailure, message: string): never {
    this.failure ??= new LedgerUnavailable(reason, message);
    throw this.failure;
  }

  /** Read, validate, change, replace durably. A refusal that changed nothing writes nothing. */
  private mutate<T>(change: (draft: LedgerFile, now: Date) => Outcome<T>): Promise<T> {
    return this.mutex.run(async () => {
      if (this.failure !== null) throw this.failure;
      try {
        await this.lock.verify();
      } catch {
        this.fail('writer_lock_lost', 'this API no longer holds the account writer lock');
      }
      let text: string;
      try {
        text = await readFile(this.realPath, 'utf8');
      } catch {
        this.fail('unreadable', 'the canonical accounting ledger could not be reread');
      }
      if (sha256(text) !== this.lastSha) this.fail('replaced_externally', 'the canonical ledger changed outside this writer');
      const current = parseLedger(text);
      const draft = structuredClone(current);
      const outcome = change(draft, this.now());
      // An idempotent replay or a refusal that changed nothing leaves the file untouched.
      if (isDeepStrictEqual(draft, current)) {
        if ('refuse' in outcome) throw outcome.refuse;
        return outcome.value;
      }
      draft.revision += 1;
      const problems = integrityProblems(draft);
      if (problems.length > 0) this.fail('invalid', `refusing to write an inconsistent ledger: ${problems[0]}`);
      const next = serializeLedger(draft);
      try {
        await durableReplace(this.realPath, next, this.options.fault);
      } catch (error) {
        if (error instanceof DurableWriteFailed) this.fail(error.phase === 'before_rename' ? 'write_failed' : 'write_uncertain', error.message);
        throw error;
      }
      this.state = draft;
      this.lastSha = sha256(next);
      if ('refuse' in outcome) throw outcome.refuse;
      return outcome.value;
    });
  }

  /** Clock and day handling shared by every admission: backward time blocks, unsettled liabilities carry forward. */
  private admit(draft: LedgerFile, now: Date): AdmissionRefusedError | null {
    if (draft.blocked !== null) return new AdmissionRefusedError('admission_blocked', `live admission is blocked (${draft.blocked.reason})`);
    if (draft.lastAdmittedAt !== null && now.getTime() < Date.parse(draft.lastAdmittedAt)) {
      draft.blocked = { reason: 'clock_regression', since: now.toISOString() };
      this.history(draft, now, 'blocked', null, null, 'clock_regression');
      return new AdmissionRefusedError('admission_blocked', 'the API clock moved backwards; admission is blocked pending reconciliation');
    }
    const day = utcDay(now);
    for (const attempt of draft.attempts) {
      if (LIVE_STATES.has(attempt.state) && !attempt.coveredDays.includes(day)) {
        attempt.coveredDays.push(day);
        this.history(draft, now, 'carried_forward', attempt.runId, attempt.attemptId, day);
      }
    }
    draft.lastAdmittedAt = now.toISOString();
    return null;
  }

  private caps(run: BudgetRun) {
    return {
      run: Math.min(run.capUnits, this.options.caps.runUnits, ACCOUNTING_POLICY.caps.runUnits),
      day: Math.min(this.options.caps.dayUnits, ACCOUNTING_POLICY.caps.dayUnits),
      lifetime: Math.min(this.options.caps.totalUnits, ACCOUNTING_POLICY.caps.lifetimeUnits),
    };
  }

  private block(draft: LedgerFile, now: Date, reason: string, attemptId: string | null) {
    draft.blocked ??= { reason, since: now.toISOString() };
    this.history(draft, now, 'blocked', null, attemptId, reason);
  }

  /** Registers a budget run under the fixed policy and freezes its cap. An identical retry returns the same run. */
  registerRun(input: RegisterRunInput): Promise<BudgetRun> {
    const registrationHash = sha256(JSON.stringify({ ...input, runId: undefined }));
    return this.mutate<BudgetRun>((draft, now) => {
      const existing = draft.runs.find((run) => run.runId === input.runId);
      if (existing !== undefined) {
        return existing.registrationHash === registrationHash ? { value: existing } : { refuse: new AdmissionRefusedError('attempt_conflict', 'this run identity is already registered with different inputs') };
      }
      if (draft.blocked !== null) return { refuse: new AdmissionRefusedError('admission_blocked', `live admission is blocked (${draft.blocked.reason})`) };
      if (!Number.isSafeInteger(input.capUnits) || input.capUnits <= 0 || input.capUnits > ACCOUNTING_POLICY.caps.runUnits) {
        return { refuse: new AdmissionRefusedError('unsupported_request', 'the run cap must be positive and at most the policy maximum') };
      }
      const run: BudgetRun = {
        runId: input.runId, callerKind: input.callerKind, capUnits: Math.min(input.capUnits, this.options.caps.runUnits), registrationHash,
        versions: input.versions, binding: input.binding, suiteDigest: input.suiteDigest, parentRunId: input.parentRunId, state: 'open', stopReason: null, createdAt: now.toISOString(),
      };
      draft.runs.push(run);
      this.history(draft, now, 'run_registered', run.runId, null, input.callerKind);
      return { value: run };
    });
  }

  /** Fences a run: no further reservation or dispatch. Already dispatched spend stays committed. */
  stopRun(runId: string, reason: string): Promise<void> {
    return this.mutate<void>((draft, now) => {
      const run = draft.runs.find((item) => item.runId === runId);
      if (run === undefined || run.state === 'stopped') return { value: undefined };
      run.state = 'stopped';
      run.stopReason = reason;
      this.history(draft, now, 'run_stopped', runId, null, reason);
      return { value: undefined };
    });
  }

  private ownedAttempt(draft: LedgerFile, runId: string, attemptId: string, owner: DispatchOwner | null): Attempt | AdmissionRefusedError {
    const attempt = draft.attempts.find((item) => item.attemptId === attemptId && item.runId === runId);
    if (attempt === undefined) return new AdmissionRefusedError('attempt_conflict', 'no such attempt for this run');
    if (owner !== null && !isDeepStrictEqual(attempt.owner, owner)) return new AdmissionRefusedError('attempt_conflict', 'the attempt belongs to another caller');
    return attempt;
  }

  /** Durable reservation of the conservative ceiling, when run, UTC-day and lifetime totals all still fit. */
  reserve(runId: string, request: AttemptReservationRequest, owner: DispatchOwner): Promise<{ attempt: Attempt; replayed: boolean }> {
    return this.mutate<{ attempt: Attempt; replayed: boolean }>((draft, now) => {
      const run = draft.runs.find((item) => item.runId === runId);
      if (run === undefined) return { refuse: new AdmissionRefusedError('run_stopped', 'the run is not registered') };
      const expectedKind = owner.kind === 'worker' ? 'packaged' : 'evaluation';
      if (run.callerKind !== expectedKind) return { refuse: new AdmissionRefusedError('attempt_conflict', 'the run belongs to another caller kind') };
      const existing = draft.attempts.find((item) => item.runId === runId && item.turn === request.turn && item.ordinal === request.ordinal);
      if (existing !== undefined) {
        // A lost acknowledgement: the identical request gets the same attempt and no second charge.
        if (existing.requestHash === request.requestHash && isDeepStrictEqual(existing.owner, owner)) return { value: { attempt: existing, replayed: true } };
        return { refuse: new AdmissionRefusedError('attempt_conflict', 'this attempt was reserved with a different request') };
      }
      if (run.state !== 'open') return { refuse: new AdmissionRefusedError('run_stopped', 'the run is stopped') };
      if (request.model !== OPUS_5_5_TARIFF.model || request.maxOutputTokens > OPUS_5_5_TARIFF.maxOutputTokens) {
        return { refuse: new AdmissionRefusedError('unsupported_request', 'only the frozen model and output bound are admitted') };
      }
      const refused = this.admit(draft, now);
      if (refused !== null) return { refuse: refused };
      const ceiling = attemptCeilingUnits(OPUS_5_5_TARIFF, request.maxOutputTokens);
      const caps = this.caps(run);
      const day = utcDay(now);
      if (runCommitted(draft, runId) + ceiling > caps.run || dayCommitted(draft, day) + ceiling > caps.day || lifetimeCommitted(draft) + ceiling > caps.lifetime) {
        return { refuse: new AdmissionRefusedError('budget_exhausted', 'another attempt would exceed the run, UTC-day or lifetime cap') };
      }
      const attempt: Attempt = {
        attemptId: randomUUID(), runId, turn: request.turn, ordinal: request.ordinal, requestHash: request.requestHash, model: request.model,
        maxOutputTokens: request.maxOutputTokens, tariff: { model: OPUS_5_5_TARIFF.model, readOn: OPUS_5_5_TARIFF.readOn, unitsPerToken: { ...OPUS_5_5_TARIFF.unitsPerToken } },
        reservedUnits: ceiling, coveredDays: [day], state: 'reserved', writerGeneration: draft.writerGeneration, owner, dispatchedAt: null, usage: null,
        actualUnits: null, incident: null, provider: null, createdAt: now.toISOString(), updatedAt: now.toISOString(), imported: null,
      };
      draft.attempts.push(attempt);
      this.history(draft, now, 'reserved', runId, attempt.attemptId);
      return { value: { attempt, replayed: false } };
    });
  }

  /** The single-use transition that alone permits one provider request. */
  dispatch(runId: string, attemptId: string, owner: DispatchOwner): Promise<Attempt> {
    return this.mutate<Attempt>((draft, now) => {
      const attempt = this.ownedAttempt(draft, runId, attemptId, owner);
      if (attempt instanceof AdmissionRefusedError) return { refuse: attempt };
      if (attempt.state !== 'reserved') return { refuse: new AdmissionRefusedError(attempt.state === 'released' ? 'attempt_conflict' : 'dispatch_already_granted', 'this attempt can never be dispatched again') };
      if (attempt.writerGeneration !== draft.writerGeneration) return { refuse: new AdmissionRefusedError('admission_blocked', 'a reservation from an earlier writer generation cannot be dispatched') };
      const run = draft.runs.find((item) => item.runId === runId)!;
      if (run.state !== 'open') return { refuse: new AdmissionRefusedError('run_stopped', 'the run is stopped') };
      if (draft.attempts.some((item) => item.state === 'dispatching')) return { refuse: new AdmissionRefusedError('dispatch_busy', 'another live request is in flight project-wide') };
      const refused = this.admit(draft, now);
      if (refused !== null) return { refuse: refused };
      // A reservation carried past midnight must also fit the new day before anything is sent.
      if (dayCommitted(draft, utcDay(now)) > this.caps(run).day) return { refuse: new AdmissionRefusedError('budget_exhausted', 'the carried reservation exceeds the UTC-day cap') };
      attempt.state = 'dispatching';
      attempt.dispatchedAt = now.toISOString();
      attempt.updatedAt = now.toISOString();
      this.history(draft, now, 'dispatched', runId, attemptId);
      return { value: attempt };
    });
  }

  /** Frees a reservation that never received a grant; the ledger itself proves nothing was sent. */
  release(runId: string, attemptId: string, owner: DispatchOwner | null): Promise<AttemptSettlement> {
    return this.mutate<AttemptSettlement>((draft, now) => {
      const attempt = this.ownedAttempt(draft, runId, attemptId, owner);
      if (attempt instanceof AdmissionRefusedError) return { refuse: attempt };
      if (attempt.state === 'released') return { value: settlement(attempt) };
      if (attempt.state !== 'reserved') return { refuse: new AdmissionRefusedError('dispatch_already_granted', 'a dispatched attempt cannot be released') };
      attempt.state = 'released';
      attempt.updatedAt = now.toISOString();
      this.history(draft, now, 'released', runId, attemptId);
      return { value: settlement(attempt) };
    });
  }

  /** Billing is unknown: the full reservation stays committed and frees the dispatch slot. */
  markUnknown(runId: string, attemptId: string, owner: DispatchOwner | null): Promise<AttemptSettlement> {
    return this.mutate<AttemptSettlement>((draft, now) => {
      const attempt = this.ownedAttempt(draft, runId, attemptId, owner);
      if (attempt instanceof AdmissionRefusedError) return { refuse: attempt };
      if (attempt.state !== 'reserved' && attempt.state !== 'dispatching') return { value: settlement(attempt) };
      attempt.state = 'unknown';
      attempt.updatedAt = now.toISOString();
      this.history(draft, now, 'unknown', runId, attemptId);
      return { value: settlement(attempt) };
    });
  }

  /**
   * Replaces the reservation with exact usage at the frozen tariff. Repeating
   * identical usage is idempotent and a late response may still settle an
   * unknown attempt; conflicting usage, an unsupported billing class or an
   * actual above the ceiling is kept in full and blocks admission.
   */
  reconcile(runId: string, attemptId: string, report: UsageReport, owner: DispatchOwner | null): Promise<AttemptSettlement> {
    return this.mutate<AttemptSettlement>((draft, now) => {
      const attempt = this.ownedAttempt(draft, runId, attemptId, owner);
      if (attempt instanceof AdmissionRefusedError) return { refuse: attempt };
      const provider = { requestId: report.providerRequestId, messageId: report.providerMessageId, model: report.model };
      if (attempt.state === 'reconciled' || (attempt.state === 'unknown' && attempt.incident !== null)) {
        if (isDeepStrictEqual(attempt.usage, report.usage) && isDeepStrictEqual(attempt.provider, provider)) return { value: settlement(attempt) };
        this.block(draft, now, 'conflicting_usage', attemptId);
        return { refuse: new AdmissionRefusedError('usage_conflict', 'different usage was already recorded for this attempt') };
      }
      if (attempt.state !== 'dispatching' && attempt.state !== 'unknown') return { refuse: new AdmissionRefusedError('not_dispatched', 'this attempt was never dispatched') };
      attempt.usage = report.usage;
      attempt.provider = provider;
      attempt.updatedAt = now.toISOString();
      // `attempt.model` is the requested identity and `provider.model` the returned one; a
      // dated snapshot of the same model is priced by the same frozen tariff.
      const unsupported = unsupportedBilling(report.usage) ?? (report.model !== null && !tariffCoversModel(OPUS_5_5_TARIFF, report.model) ? 'priced_model_mismatch' : null);
      if (unsupported !== null) {
        attempt.state = 'unknown';
        attempt.incident = 'unsupported_billing';
        this.history(draft, now, 'unknown', runId, attemptId, unsupported);
        this.block(draft, now, 'unsupported_billing', attemptId);
        return { value: settlement(attempt) };
      }
      attempt.state = 'reconciled';
      attempt.actualUnits = usageUnits(OPUS_5_5_TARIFF, report.usage);
      this.history(draft, now, 'reconciled', runId, attemptId, report.model !== null && report.model !== attempt.model ? `returned_model:${report.model}` : null);
      if (attempt.actualUnits > attempt.reservedUnits) {
        attempt.incident = 'over_ceiling';
        this.block(draft, now, 'over_ceiling', attemptId);
      }
      return { value: settlement(attempt) };
    });
  }

  /**
   * Maintenance recovery after an operator confirmed that the previous writer
   * and every recorded dispatch owner have stopped: in-flight grants become
   * unknown holds, never-dispatched reservations of earlier generations are
   * released, and a persisted block is cleared with its reason recorded.
   */
  recover(options: { clearBlock: boolean }): Promise<{ unknown: number; released: number; clearedBlock: string | null }> {
    return this.mutate<{ unknown: number; released: number; clearedBlock: string | null }>((draft, now) => {
      let unknown = 0;
      let released = 0;
      for (const attempt of draft.attempts) {
        if (attempt.state === 'dispatching') {
          attempt.state = 'unknown';
          attempt.updatedAt = now.toISOString();
          this.history(draft, now, 'recovered', attempt.runId, attempt.attemptId, 'dispatch_owner_stopped');
          unknown += 1;
        } else if (attempt.state === 'reserved' && attempt.writerGeneration < draft.writerGeneration) {
          attempt.state = 'released';
          attempt.updatedAt = now.toISOString();
          this.history(draft, now, 'recovered', attempt.runId, attempt.attemptId, 'never_dispatched');
          released += 1;
        }
      }
      const clearedBlock = options.clearBlock && draft.blocked !== null ? draft.blocked.reason : null;
      if (clearedBlock !== null) {
        draft.blocked = null;
        // The clock check restarts from now; an earlier clock still cannot pass it once admission resumes.
        draft.lastAdmittedAt = now.toISOString();
        this.history(draft, now, 'recovered', null, null, `cleared:${clearedBlock}`);
      }
      return { value: { unknown, released, clearedBlock } };
    });
  }

  /** Removes temporary files left by an interrupted replacement; they were never read as accounting. */
  async removeTemporaryFiles(): Promise<number> {
    const directory = dirname(this.realPath);
    const names = (await readdir(directory)).filter((name) => isTemporaryName(this.realPath, name));
    for (const name of names) await unlink(join(directory, name));
    this.strayTemporaryFiles = 0;
    return names.length;
  }

  /** The last confirmed state, for read-only summaries. */
  snapshot(): LedgerFile {
    return structuredClone(this.state);
  }

  status(): AdmissionStatus {
    const ledger = this.state;
    const day = utcDay(this.now());
    const dayUnits = dayCommitted(ledger, day);
    const lifetimeUnits = lifetimeCommitted(ledger);
    const reason = this.failure?.reason ?? (ledger.blocked === null ? null : ledger.blocked.reason);
    return {
      open: reason === null, reason, failure: this.failure?.reason ?? null, writerGeneration: ledger.writerGeneration, day, dayCommittedUnits: dayUnits, lifetimeCommittedUnits: lifetimeUnits,
      remaining: {
        dayUnits: Math.max(0, Math.min(this.options.caps.dayUnits, ACCOUNTING_POLICY.caps.dayUnits) - dayUnits),
        lifetimeUnits: Math.max(0, Math.min(this.options.caps.totalUnits, ACCOUNTING_POLICY.caps.lifetimeUnits) - lifetimeUnits),
      },
      activeDispatches: ledger.attempts.filter((item) => item.state === 'dispatching').length,
      heldUnknownUnits: sum(ledger.attempts.filter((item) => item.state === 'unknown')),
      strayTemporaryFiles: this.strayTemporaryFiles,
    };
  }

  runSummary(runId: string): BudgetRunSummary | null {
    const ledger = this.state;
    const run = ledger.runs.find((item) => item.runId === runId);
    if (run === undefined) return null;
    const attempts = ledger.attempts.filter((item) => item.runId === runId);
    return {
      runId, capUnits: run.capUnits, state: run.state, attempts: attempts.length, runCommittedUnits: sum(attempts),
      dayCommittedUnits: dayCommitted(ledger, utcDay(this.now())), lifetimeCommittedUnits: lifetimeCommitted(ledger),
      heldUnits: sum(attempts.filter((item) => item.state !== 'reconciled')),
    };
  }

  /** True while any attempt of the run holds the project's dispatch slot. */
  hasActiveDispatch(runId: string): boolean {
    return this.state.attempts.some((item) => item.runId === runId && item.state === 'dispatching');
  }

  /** Releases the writer lock on a graceful stop, which itself proves this writer stopped. */
  async close(): Promise<void> {
    await this.mutex.run(async () => {
      if (this.failure === null) {
        try {
          await this.lock.verify();
        } catch {
          return;
        }
      }
      await this.lock.release().catch(() => undefined);
      this.failure ??= new LedgerUnavailable('writer_lock_lost', 'the ledger writer was closed');
    });
  }
}

function settlement(attempt: Attempt): AttemptSettlement {
  return { attemptId: attempt.attemptId, state: attempt.state, actualUnits: attempt.actualUnits };
}
