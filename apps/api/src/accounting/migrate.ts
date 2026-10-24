import { readFile, realpath } from 'node:fs/promises';

import { ACCOUNTING_POLICY, OPUS_5_5_TARIFF, UNITS_PER_USD, usageUnits } from '@pa/agents/admission';
import type { ProviderUsage } from '@pa/contracts';

import { durableReplace } from './durable.js';
import { committedUnits, integrityProblems, LedgerUnavailable, serializeLedger, sha256 } from './ledger.js';
import { acquireWriterLock, type ProcessProbe } from './lock.js';
import { LEDGER_SCHEMA, LedgerFile, LegacyLedger, type Attempt, type BudgetRun, type LegacyEntry, type MigrationManifest } from './schema.js';

/** The source cannot be migrated as-is; nothing was written. */
export class MigrationConflict extends Error {
  override name = 'MigrationConflict';
}

// Float serialization residue in v1 values is far below one accounting unit.
const RESIDUE_USD = 1e-9;
/** Smallest whole number of units not below a raw USD value, ignoring residue. */
const ceilUnits = (usd: number) => Math.ceil(usd * UNITS_PER_USD - RESIDUE_USD * UNITS_PER_USD);

function legacyUsage(entry: LegacyEntry): ProviderUsage | null {
  if (entry.usage === null) return null;
  return { ...entry.usage, cacheWrite1hInputTokens: 0, serverToolRequests: 0, serviceTier: null, inferenceGeo: null };
}

/**
 * One v1 entry as an imported attempt. Raw values stay in `imported.entry`.
 * An old `reserved` entry belongs to a process that is gone: it becomes an
 * unknown hold in full, never a release.
 */
function importEntry(entry: LegacyEntry, ordinal: number): Attempt {
  const usage = legacyUsage(entry);
  const reservedUnits = ceilUnits(entry.reservedUsd);
  let actualUnits: number | null = null;
  if (entry.status === 'reconciled') {
    if (entry.actualUsd === null) throw new MigrationConflict(`reconciled entry ${entry.reservationId} has no actual`);
    actualUnits = ceilUnits(entry.actualUsd);
    if (usage !== null && entry.model === OPUS_5_5_TARIFF.model) {
      const recomputed = usageUnits(OPUS_5_5_TARIFF, usage);
      if (Math.abs(recomputed / UNITS_PER_USD - entry.actualUsd) > RESIDUE_USD) throw new MigrationConflict(`entry ${entry.reservationId} actual differs from its usage at the recorded tariff`);
      actualUnits = recomputed;
    }
  }
  return {
    attemptId: entry.reservationId, runId: entry.runId, turn: 0, ordinal, requestHash: null, model: entry.model, maxOutputTokens: null,
    tariff: { model: OPUS_5_5_TARIFF.model, readOn: OPUS_5_5_TARIFF.readOn, unitsPerToken: { ...OPUS_5_5_TARIFF.unitsPerToken } },
    reservedUnits, coveredDays: [entry.day], state: entry.status === 'reconciled' ? 'reconciled' : 'unknown', writerGeneration: 0, owner: null,
    dispatchedAt: null, usage, actualUnits, incident: null, provider: null, createdAt: entry.createdAt, updatedAt: entry.createdAt,
    imported: { source: 'pa.anthropic-spend.v1', entry },
  };
}

export function convertLegacy(source: LegacyLedger, sourceBytes: Buffer, ledgerPath: string, now: Date): LedgerFile {
  const ids = new Set<string>();
  for (const entry of source.entries) {
    if (ids.has(entry.reservationId)) throw new MigrationConflict(`duplicate reservation ${entry.reservationId}`);
    ids.add(entry.reservationId);
  }
  const attempts = source.entries.map((entry, index) => importEntry(entry, index));
  const committed = attempts.reduce((total, attempt) => total + committedUnits(attempt), 0);
  if (Math.abs(committed / UNITS_PER_USD - source.committedUsd) > 1e-6) throw new MigrationConflict('the stored committed total differs from its entries');
  const tally = (key: (attempt: Attempt) => string) => {
    const totals: Record<string, number> = {};
    for (const attempt of attempts) totals[key(attempt)] = (totals[key(attempt)] ?? 0) + committedUnits(attempt);
    return totals;
  };
  const byStatus = { reserved: 0, reconciled: 0, unknown_usage: 0 };
  for (const entry of source.entries) byStatus[entry.status] += 1;
  const migration: MigrationManifest = {
    sourceSchema: 'pa.anthropic-spend.v1', sourceSha256: sha256(sourceBytes), sourceBytes: sourceBytes.length, entries: attempts.length, byStatus,
    sourceCommittedUsd: source.committedUsd, committedUnits: committed, runs: tally((attempt) => attempt.runId), days: tally((attempt) => attempt.coveredDays[0]!),
    migratedAt: now.toISOString(),
  };
  const runs: BudgetRun[] = [...new Set(attempts.map((attempt) => attempt.runId))].map((runId) => ({
    runId, callerKind: 'imported', capUnits: ACCOUNTING_POLICY.caps.runUnits, registrationHash: null, versions: null, binding: null, suiteDigest: null,
    parentRunId: null, state: 'stopped', stopReason: 'imported', createdAt: attempts.find((attempt) => attempt.runId === runId)!.createdAt,
  }));
  const ledger: LedgerFile = {
    schemaVersion: LEDGER_SCHEMA,
    account: { accountId: ACCOUNTING_POLICY.accountId, policyVersion: ACCOUNTING_POLICY.policyVersion, caps: { ...ACCOUNTING_POLICY.caps }, ledgerPath, createdAt: now.toISOString(), migration },
    revision: 1, writerGeneration: 0, lastAdmittedAt: null, blocked: null, runs, attempts,
    history: [{ seq: 1, at: now.toISOString(), generation: 0, kind: 'migrated', runId: null, attemptId: null, detail: `${attempts.length} entries` }],
  };
  const problems = integrityProblems(LedgerFile.parse(ledger));
  if (problems.length > 0) throw new MigrationConflict(`converted ledger failed integrity validation: ${problems[0]}`);
  return ledger;
}

/** Every source entry is present, unchanged, under its original ID. */
function verifyReplay(ledger: LedgerFile, source: LegacyLedger, sourceSha: string) {
  if (ledger.account.migration.sourceSha256 !== sourceSha) throw new MigrationConflict('the ledger was migrated from a different source');
  const imported = new Map(ledger.attempts.filter((attempt) => attempt.imported !== null).map((attempt) => [attempt.attemptId, attempt.imported!.entry]));
  if (imported.size !== source.entries.length) throw new MigrationConflict('imported history is missing or extra entries');
  for (const entry of source.entries) {
    if (JSON.stringify(imported.get(entry.reservationId)) !== JSON.stringify(entry)) throw new MigrationConflict(`entry ${entry.reservationId} changed under its original ID`);
  }
}

export interface MigrationResult {
  outcome: 'migrated' | 'already_migrated';
  manifest: MigrationManifest;
}

/**
 * Converts the canonical ledger in place from `pa.anthropic-spend.v1`. The
 * file must be byte-identical to the separately retained source copy, and
 * conversion holds maintenance ownership of the account lock. A replay with
 * the same source verifies every entry and changes nothing.
 */
export async function migrateLedger(options: { ledgerPath: string; sourceCopy: string; now?: () => Date; probe?: ProcessProbe }): Promise<MigrationResult> {
  const now = (options.now ?? (() => new Date()))();
  let realPath: string;
  try {
    realPath = await realpath(options.ledgerPath);
  } catch {
    throw new LedgerUnavailable('missing', 'the ledger to migrate does not exist; migration never creates an account from nothing');
  }
  const sourceBytes = await readFile(options.sourceCopy);
  const sourceSha = sha256(sourceBytes);
  let source: LegacyLedger;
  try {
    source = LegacyLedger.parse(JSON.parse(sourceBytes.toString('utf8')));
  } catch {
    throw new MigrationConflict(`the retained copy is not a valid pa.anthropic-spend.v1 ledger`);
  }
  const lock = await acquireWriterLock({ ledgerPath: realPath, purpose: 'maintenance', probe: options.probe, now: () => now });
  try {
    const current = await readFile(realPath);
    const parsed = (() => { try { return JSON.parse(current.toString('utf8')) as { schemaVersion?: unknown }; } catch { return null; } })();
    if (parsed?.schemaVersion === LEDGER_SCHEMA) {
      const ledger = LedgerFile.parse(parsed);
      if (ledger.account.ledgerPath !== options.ledgerPath) throw new MigrationConflict('the ledger was migrated for a different configured path');
      verifyReplay(ledger, source, sourceSha);
      return { outcome: 'already_migrated', manifest: ledger.account.migration };
    }
    if (sha256(current) !== sourceSha) throw new MigrationConflict('the ledger differs from the retained copy; quiesce every old writer and retain it again');
    const ledger = convertLegacy(source, sourceBytes, options.ledgerPath, now);
    await durableReplace(realPath, serializeLedger(ledger));
    return { outcome: 'migrated', manifest: ledger.account.migration };
  } finally {
    await lock.release().catch(() => undefined);
  }
}
