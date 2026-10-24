import { z } from 'zod';

import { ACCOUNTING_POLICY } from '@pa/agents/admission';
import { AttemptState, ProviderUsage, RunVersionsRecord, Sha256Hex } from '@pa/contracts';

/**
 * `pa.accounting-ledger.v2`: the one canonical accounting record for this
 * project (ADR 0001). The API process is its only writer. PostgreSQL holds no
 * authoritative spend, so a database restore can never roll it back.
 */
export const LEDGER_SCHEMA = 'pa.accounting-ledger.v2';
export const LEGACY_SCHEMA = 'pa.anthropic-spend.v1';

const Units = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const Day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const Instant = z.iso.datetime();

export const TariffRecord = z.strictObject({
  model: z.string().min(1).max(120),
  readOn: Day,
  unitsPerToken: z.strictObject({ input: Units, cacheWrite5m: Units, cacheRead: Units, output: Units }),
});
export type TariffRecord = z.infer<typeof TariffRecord>;

/** Original `pa.anthropic-spend.v1` entry, kept byte-for-value in the evolved record. */
export const LegacyEntry = z.strictObject({
  reservationId: z.uuid(), runId: z.string().min(1).max(200), day: Day, createdAt: Instant, model: z.string().min(1).max(120),
  reservedUsd: z.number().positive(), actualUsd: z.number().nonnegative().nullable(),
  usage: z.strictObject({ inputTokens: z.int().nonnegative(), outputTokens: z.int().nonnegative(), cacheCreationInputTokens: z.int().nonnegative(), cacheReadInputTokens: z.int().nonnegative() }).nullable(),
  status: z.enum(['reserved', 'reconciled', 'unknown_usage']),
});
export type LegacyEntry = z.infer<typeof LegacyEntry>;
export const LegacyLedger = z.strictObject({ schemaVersion: z.literal(LEGACY_SCHEMA), committedUsd: z.number().nonnegative(), entries: z.array(LegacyEntry) });
export type LegacyLedger = z.infer<typeof LegacyLedger>;

export const DispatchOwner = z.strictObject({ kind: z.enum(['worker', 'evaluation']), id: z.string().min(1).max(200) });
export type DispatchOwner = z.infer<typeof DispatchOwner>;

export const Attempt = z.strictObject({
  attemptId: z.uuid(),
  runId: z.string().min(1).max(200),
  turn: z.int().nonnegative(),
  ordinal: z.int().nonnegative(),
  /** Null only for imported legacy entries, whose request bodies were never recorded. */
  requestHash: Sha256Hex.nullable(),
  model: z.string().min(1).max(120),
  maxOutputTokens: z.int().positive().nullable(),
  tariff: TariffRecord,
  reservedUnits: Units,
  /** API-host UTC day of the reservation, then every later day it was carried into while unsettled. */
  coveredDays: z.array(Day).min(1),
  state: AttemptState,
  /** Writer generation that created the reservation; only that generation can grant dispatch. */
  writerGeneration: z.int().nonnegative(),
  owner: DispatchOwner.nullable(),
  dispatchedAt: Instant.nullable(),
  usage: ProviderUsage.nullable(),
  actualUnits: Units.nullable(),
  incident: z.enum(['over_ceiling', 'unsupported_billing']).nullable(),
  provider: z.strictObject({ requestId: z.string().nullable(), messageId: z.string().nullable(), model: z.string().nullable() }).nullable(),
  createdAt: Instant,
  updatedAt: Instant,
  imported: z.strictObject({ source: z.literal(LEGACY_SCHEMA), entry: LegacyEntry }).nullable(),
});
export type Attempt = z.infer<typeof Attempt>;

export const BudgetRun = z.strictObject({
  runId: z.string().min(1).max(200),
  callerKind: z.enum(['packaged', 'evaluation', 'imported']),
  capUnits: Units,
  /** Digest of the registration input; an identical retry returns the run, a changed one is refused. */
  registrationHash: Sha256Hex.nullable(),
  versions: RunVersionsRecord.nullable(),
  binding: z.strictObject({ caseId: z.string().min(1).max(200), bindingHash: Sha256Hex }).nullable(),
  suiteDigest: Sha256Hex.nullable(),
  parentRunId: z.string().min(1).max(200).nullable(),
  state: z.enum(['open', 'stopped']),
  stopReason: z.string().max(80).nullable(),
  createdAt: Instant,
});
export type BudgetRun = z.infer<typeof BudgetRun>;

export const HistoryEntry = z.strictObject({
  seq: z.int().positive(),
  at: Instant,
  generation: z.int().nonnegative(),
  kind: z.enum([
    'migrated', 'writer_acquired', 'writer_released', 'run_registered', 'run_stopped', 'reserved', 'dispatched', 'released', 'reconciled', 'unknown',
    'carried_forward', 'blocked', 'recovered',
  ]),
  runId: z.string().max(200).nullable(),
  attemptId: z.uuid().nullable(),
  detail: z.string().max(200).nullable(),
});
export type HistoryEntry = z.infer<typeof HistoryEntry>;

export const MigrationManifest = z.strictObject({
  sourceSchema: z.literal(LEGACY_SCHEMA),
  sourceSha256: Sha256Hex,
  sourceBytes: z.int().positive(),
  entries: z.int().nonnegative(),
  byStatus: z.strictObject({ reserved: z.int().nonnegative(), reconciled: z.int().nonnegative(), unknown_usage: z.int().nonnegative() }),
  /** The stored v1 aggregate, raw, and the exact recomputation from entries. */
  sourceCommittedUsd: z.number().nonnegative(),
  committedUnits: Units,
  runs: z.record(z.string(), Units),
  days: z.record(z.string(), Units),
  migratedAt: Instant,
});
export type MigrationManifest = z.infer<typeof MigrationManifest>;

export const LedgerFile = z.strictObject({
  schemaVersion: z.literal(LEDGER_SCHEMA),
  account: z.strictObject({
    accountId: z.literal(ACCOUNTING_POLICY.accountId),
    policyVersion: z.literal(ACCOUNTING_POLICY.policyVersion),
    /** Immutable maxima: validation refuses any value other than the fixed policy. */
    caps: z.strictObject({ runUnits: z.literal(ACCOUNTING_POLICY.caps.runUnits), dayUnits: z.literal(ACCOUNTING_POLICY.caps.dayUnits), lifetimeUnits: z.literal(ACCOUNTING_POLICY.caps.lifetimeUnits) }),
    /** The configured location this account was created for; any other path is refused. */
    ledgerPath: z.string().min(1).max(1024),
    createdAt: Instant,
    migration: MigrationManifest,
  }),
  revision: z.int().positive(),
  writerGeneration: z.int().nonnegative(),
  lastAdmittedAt: Instant.nullable(),
  /** A persisted integrity stop; only maintenance recovery clears it. */
  blocked: z.strictObject({ reason: z.string().min(1).max(80), since: Instant }).nullable(),
  runs: z.array(BudgetRun),
  attempts: z.array(Attempt),
  history: z.array(HistoryEntry),
});
export type LedgerFile = z.infer<typeof LedgerFile>;
