import { z } from 'zod';

import { Sha256Hex } from '../domain/common.js';

/**
 * Bounded spend admission operations (ADR 0001). The API owns the one
 * canonical accounting ledger; the worker and the evaluation CLI reach it only
 * through these routes, never through a file. Amounts cross the wire as exact
 * integer units of USD 0.0000001.
 */
export const EVALUATION_ADMISSION_PATH = '/internal/evaluation/v1';

export const AccountingUnits = z.int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One provider attempt. A repeated identical request returns the same attempt; a changed hash is refused. */
export const AttemptReservationRequest = z.strictObject({
  // Packaged runs count turns per investigation; an evaluation run numbers attempts across its cases.
  turn: z.int().min(0).max(10_000),
  ordinal: z.int().min(0).max(16),
  requestHash: Sha256Hex,
  model: z.string().min(1).max(120),
  maxOutputTokens: z.int().positive().max(128_000),
});
export type AttemptReservationRequest = z.infer<typeof AttemptReservationRequest>;

export const AttemptState = z.enum(['reserved', 'dispatching', 'reconciled', 'unknown', 'released']);
export type AttemptState = z.infer<typeof AttemptState>;

export const AttemptReservation = z.strictObject({
  attemptId: z.uuid(), state: AttemptState, reservedUnits: AccountingUnits, replayed: z.boolean(),
});
export type AttemptReservation = z.infer<typeof AttemptReservation>;

/** The single-use transition that alone permits one provider request. */
export const DispatchGrant = z.strictObject({ attemptId: z.uuid(), state: z.literal('dispatching'), writerGeneration: z.int().positive() });
export type DispatchGrant = z.infer<typeof DispatchGrant>;

/** Every billed class the provider reports; unsupported classes hold the reservation. */
export const ProviderUsage = z.strictObject({
  inputTokens: z.int().nonnegative(),
  outputTokens: z.int().nonnegative(),
  cacheCreationInputTokens: z.int().nonnegative(),
  cacheReadInputTokens: z.int().nonnegative(),
  /** One-hour cache writes are refused by policy; a nonzero count is an integrity incident. */
  cacheWrite1hInputTokens: z.int().nonnegative(),
  serverToolRequests: z.int().nonnegative(),
  serviceTier: z.string().max(40).nullable(),
  inferenceGeo: z.string().max(40).nullable(),
});
export type ProviderUsage = z.infer<typeof ProviderUsage>;

/** Sanitized provider identity only: no bodies, reasoning or headers. */
export const UsageReport = z.strictObject({
  usage: ProviderUsage,
  providerRequestId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable(),
  providerMessageId: z.string().regex(/^[A-Za-z0-9_-]{1,200}$/).nullable(),
  model: z.string().min(1).max(120).nullable(),
});
export type UsageReport = z.infer<typeof UsageReport>;

export const AttemptSettlement = z.strictObject({ attemptId: z.uuid(), state: AttemptState, actualUnits: AccountingUnits.nullable() });
export type AttemptSettlement = z.infer<typeof AttemptSettlement>;

export const RunVersionsRecord = z.strictObject({
  source: z.string().min(1).max(80), build: z.string().min(1).max(80), prompt: z.string().min(1).max(80),
  tools: z.string().min(1).max(80), provider: z.string().min(1).max(200),
});
export type RunVersionsRecord = z.infer<typeof RunVersionsRecord>;

/** Evaluation CLI run registration. `registrationId` makes a lost acknowledgement safe to repeat. */
export const EvaluationRunRegistration = z.strictObject({
  registrationId: z.uuid(),
  /** Decimal USD with at most seven fractional digits, positive and at most the policy run maximum. */
  capUsd: z.string().regex(/^\d{1,2}(\.\d{1,7})?$/),
  suiteDigest: Sha256Hex,
  versions: RunVersionsRecord,
});
export type EvaluationRunRegistration = z.infer<typeof EvaluationRunRegistration>;

export const BudgetRunSummary = z.strictObject({
  runId: z.string().min(1).max(200),
  capUnits: AccountingUnits,
  state: z.enum(['open', 'stopped']),
  attempts: z.int().nonnegative(),
  runCommittedUnits: AccountingUnits,
  dayCommittedUnits: AccountingUnits,
  lifetimeCommittedUnits: AccountingUnits,
  heldUnits: AccountingUnits,
});
export type BudgetRunSummary = z.infer<typeof BudgetRunSummary>;

export const AdmissionRefusalCode = z.enum([
  'budget_exhausted', 'dispatch_busy', 'run_stopped', 'binding_stale', 'admission_blocked', 'attempt_conflict', 'dispatch_already_granted',
  'not_dispatched', 'usage_conflict', 'unsupported_request',
]);
export type AdmissionRefusalCode = z.infer<typeof AdmissionRefusalCode>;
