import { z } from 'zod';

import { DocumentVersion, Identifier, JsonPointer, Sha256Hex } from '../domain/common.js';
import { EvidenceField } from '../domain/evidence.js';
import { RecipientRole, RequestTemplate, RevisionBinding } from '../workflow/commands.js';

export * from './admission.js';

export const AGENT_QUEUE = 'agent-run';
export const AGENT_WORKER_PATH = '/internal/worker/v1/agent-runs';

/**
 * Run labels kept separate by the SPEC. A recorded or scripted provider is
 * `scripted_fixture` and is never presented as an agent run; `live_claude` is
 * an actual, budgeted model run admitted through the API's accounting ledger.
 */
export const AgentRunLabel = z.enum(['rules_only', 'scripted_fixture', 'live_claude']);
export type AgentRunLabel = z.infer<typeof AgentRunLabel>;
export const AgentProviderName = z.enum(['recorded', 'anthropic']);
export type AgentProviderName = z.infer<typeof AgentProviderName>;
export const RecordingId = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);

export const AgentVersions = z.strictObject({
  graph: z.string().min(1).max(80),
  stateSchema: z.string().min(1).max(80),
  prompt: z.string().min(1).max(80),
  provider: z.string().min(1).max(200),
});
export type AgentVersions = z.infer<typeof AgentVersions>;

export const AgentJobPayload = z.strictObject({ runId: z.uuid(), phase: z.enum(['start', 'resume']) });
export type AgentJobPayload = z.infer<typeof AgentJobPayload>;

export const StartAgentRunCommand = z.strictObject({
  eventId: z.uuid(), expectedRevision: z.int().positive(), provider: AgentProviderName, recordingId: RecordingId.optional(),
});
export type StartAgentRunCommand = z.infer<typeof StartAgentRunCommand>;

/** Persisted run scope the API returns to the worker that holds the active job. */
export const AgentRunScope = z.strictObject({
  runId: z.uuid(), caseId: Identifier, revision: z.int().positive(), binding: RevisionBinding,
  threadId: z.string().min(1).max(200), phase: z.enum(['start', 'resume']), provider: AgentProviderName,
  recordingId: RecordingId.nullable(), versions: AgentVersions, reviewEventId: z.uuid().nullable(),
});
export type AgentRunScope = z.infer<typeof AgentRunScope>;

/** Untrusted model candidate. The API alone builds and validates the stored fact. */
export const ModelFactCandidate = z.strictObject({
  field: EvidenceField, documentId: Identifier, documentVersion: DocumentVersion, locator: JsonPointer,
  value: z.union([z.string().max(4096), z.number(), z.boolean()]), originalText: z.string().max(4096),
  confidence: z.number().min(0).max(1), sourceContentHash: Sha256Hex,
});
export type ModelFactCandidate = z.infer<typeof ModelFactCandidate>;
/** Template choice only: the request body is fixed server text, never model output. */
export const ModelRequestCandidate = z.strictObject({ findingId: Identifier, templateId: RequestTemplate, recipientRole: RecipientRole });
export type ModelRequestCandidate = z.infer<typeof ModelRequestCandidate>;

export const ProposalKey = z.string().regex(/^[A-Za-z0-9:_-]{1,200}$/);
export const AgentProposalSubmission = z.strictObject({
  proposalKey: ProposalKey, kind: z.enum(['fact', 'request']), candidate: z.unknown(),
});
export type AgentProposalSubmission = z.infer<typeof AgentProposalSubmission>;
export const ProposalRejection = z.enum([
  'invalid_schema', 'binding_stale', 'source_unavailable', 'source_hash_mismatch', 'locator_mismatch',
  'value_mismatch', 'low_confidence', 'request_not_applicable',
]);
export type ProposalRejection = z.infer<typeof ProposalRejection>;
export const AgentProposalResult = z.strictObject({
  proposalId: z.uuid(), status: z.enum(['valid', 'rejected']), code: ProposalRejection.nullable(),
});
export type AgentProposalResult = z.infer<typeof AgentProposalResult>;

/** Sanitized trace step: identities, hashes, timings and outcomes, never bodies or reasoning. */
export const AgentTraceStep = z.strictObject({
  step: z.int().nonnegative(), kind: z.enum(['model', 'tool']), name: z.string().regex(/^[a-z_:.-]{1,64}$/),
  outcome: z.string().regex(/^[a-z_]{1,64}$/), inputHash: Sha256Hex, outputHash: Sha256Hex,
  elapsedMs: z.int().nonnegative(), retries: z.int().nonnegative(),
});
export type AgentTraceStep = z.infer<typeof AgentTraceStep>;
export const AgentStopReason = z.enum(['finished', 'model_call_limit', 'tool_call_limit', 'time_limit', 'invalid_model_output', 'output_limit']);
export type AgentStopReason = z.infer<typeof AgentStopReason>;
export const ModelIdentity = z.strictObject({
  provider: AgentProviderName, model: z.string().min(1).max(120), label: AgentRunLabel, recordingSha256: Sha256Hex.nullable(),
});
export type ModelIdentity = z.infer<typeof ModelIdentity>;
export const AgentRunReport = z.strictObject({
  jobId: z.uuid(), trace: z.array(AgentTraceStep).max(200), stopReason: AgentStopReason, modelIdentity: ModelIdentity,
});
export type AgentRunReport = z.infer<typeof AgentRunReport>;
/** After resume. `inputsChanged` is the worker's view; the API rechecks it independently. */
export const AgentCompletionReport = z.strictObject({ jobId: z.uuid(), trace: z.array(AgentTraceStep).max(200), inputsChanged: z.boolean() });
export type AgentCompletionReport = z.infer<typeof AgentCompletionReport>;
export const AgentRunFailureCode = z.enum([
  'incompatible_checkpoint', 'live_provider_disabled', 'recording_unavailable', 'agent_error',
  // Live runs: refused before any request, or stopped with their accounting retained.
  'live_provider_unavailable', 'budget_refused', 'admission_unavailable', 'interrupted_before_review',
]);
export type AgentRunFailureCode = z.infer<typeof AgentRunFailureCode>;
export const AgentRunFailure = z.strictObject({ jobId: z.uuid(), code: AgentRunFailureCode });

/**
 * A worker's claim of one job. The worker picks `claimId` once per job it
 * processes and repeats it on retries, so a claim whose response was lost is
 * recognised instead of being mistaken for a redelivery after a crash.
 */
export const AgentJobClaim = z.strictObject({ claimId: z.uuid() });
export type AgentJobClaim = z.infer<typeof AgentJobClaim>;
export type AgentRunFailure = z.infer<typeof AgentRunFailure>;

/** Server-owned reviewer identity; a model can never name an approver. */
export const AgentReviewCommand = z.strictObject({
  eventId: z.uuid(),
  decisions: z.array(z.strictObject({ proposalId: z.uuid(), decision: z.enum(['accept', 'reject']) })).max(100),
});
export type AgentReviewCommand = z.infer<typeof AgentReviewCommand>;

/** Operator recovery for a run stranded before review or completion; later worker reports are refused. */
export const CancelAgentRunCommand = z.strictObject({ eventId: z.uuid() });
export type CancelAgentRunCommand = z.infer<typeof CancelAgentRunCommand>;

/**
 * What the operator may start. Live availability and redacted limits only:
 * never a key, path or ledger detail. Amounts are display USD derived from
 * exact accounting units.
 */
export const AgentCapability = z.strictObject({
  defaultMode: z.literal('rules_only'),
  graphProvider: z.enum(['off', 'recorded', 'live']),
  live: z.strictObject({
    enabled: z.boolean(),
    reason: z.enum(['disabled_by_configuration', 'available', 'accounting_unavailable', 'admission_blocked', 'cap_below_attempt_ceiling']),
    runBudgetUsd: z.number().nonnegative(),
    dailyBudgetUsd: z.number().nonnegative(),
    totalBudgetUsd: z.number().nonnegative(),
    /** Headroom after committed spend and held reservations; null when accounting is not open. */
    remaining: z.strictObject({ dayUsd: z.number().nonnegative(), lifetimeUsd: z.number().nonnegative() }).nullable(),
    /** The conservative amount held before each provider attempt. */
    attemptReservationUsd: z.number().nonnegative(),
  }),
});
export type AgentCapability = z.infer<typeof AgentCapability>;
