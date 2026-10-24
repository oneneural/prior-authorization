import { z } from 'zod';

import { AgentCapability } from './agent/index.js';

// Versioned DTOs for the packaging pilot. `PilotProbe` is a synthetic transport
// record that proves service boundaries; it is not a SPEC domain contract.

export const CONTRACT_VERSION = 'v1';

/** Permanent label required on every user-facing state (PA-A11). */
export const PILOT_NOTICE = 'Synthetic data. Administrative review only. No payer submission.';

export const IDEMPOTENCY_KEY_HEADER = 'idempotency-key';

export const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/, 'must be 16-128 characters of A-Z, a-z, 0-9, _ or -');

export const CreateProbeRequest = z.strictObject({
  label: z.string().trim().min(1).max(80),
});
export type CreateProbeRequest = z.infer<typeof CreateProbeRequest>;

export const ProbeStatus = z.enum(['queued', 'completed']);
export type ProbeStatus = z.infer<typeof ProbeStatus>;

/** Deterministic worker output, so a redelivered job reports an identical result. */
export const WorkerResult = z.strictObject({
  outcome: z.literal('processed'),
  probeDigest: z.string().regex(/^[0-9a-f]{64}$/),
});
export type WorkerResult = z.infer<typeof WorkerResult>;

export const PilotProbe = z.strictObject({
  probeId: z.uuid(),
  idempotencyKey: IdempotencyKey,
  synthetic: z.literal(true),
  label: z.string(),
  status: ProbeStatus,
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  completedAt: z.iso.datetime({ offset: true }).nullable(),
  workerResult: WorkerResult.nullable(),
});
export type PilotProbe = z.infer<typeof PilotProbe>;

/**
 * Probe as listed on the unauthenticated status endpoint. It omits the
 * idempotency key, which would let any reader replay the original request.
 */
export const PilotProbeSummary = PilotProbe.omit({ idempotencyKey: true });
export type PilotProbeSummary = z.infer<typeof PilotProbeSummary>;

export const CreateProbeResponse = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  probe: PilotProbe,
  replayed: z.boolean(),
});
export type CreateProbeResponse = z.infer<typeof CreateProbeResponse>;

/** Image build metadata; `unknown` outside a labelled image build. */
export const BuildInfo = z.strictObject({
  revision: z.string().regex(/^[0-9A-Za-z._-]{1,64}$/),
});
export type BuildInfo = z.infer<typeof BuildInfo>;

export const StatusResponse = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  appId: z.literal('prior-authorization'),
  notice: z.literal(PILOT_NOTICE),
  build: BuildInfo,
  modes: z.strictObject({
    data: z.literal('fixture'),
    agent: z.literal('rules'),
    /** The configured AGENT_GRAPH_PROVIDER; `agent` stays the AGENT_MODE baseline. */
    agentGraph: AgentCapability.shape.graphProvider,
    auth: z.literal('fixture'),
  }),
  database: z.strictObject({
    checkedAt: z.iso.datetime({ offset: true }),
  }),
  probes: z.array(PilotProbeSummary),
});
export type StatusResponse = z.infer<typeof StatusResponse>;

export const ErrorCode = z.enum([
  'invalid_request',
  'invalid_idempotency_key',
  'idempotency_conflict',
  'unauthorized',
  'job_reference_mismatch',
  'job_not_active',
  'result_conflict',
  'not_found',
  'payload_too_large',
  'upstream_unavailable',
  'database_unavailable',
  'shutting_down',
  'internal_error',
  'capability_disabled',
  'forbidden',
  'conflict',
  'csrf_rejected',
]);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorResponse = z.strictObject({
  error: z.strictObject({
    code: ErrorCode,
    message: z.string(),
  }),
});
export type ErrorResponse = z.infer<typeof ErrorResponse>;

/** Queue payload: a reference only, never a credential or authority grant. */
export const PilotJobPayload = z.strictObject({
  probeId: z.uuid(),
});
export type PilotJobPayload = z.infer<typeof PilotJobPayload>;

/** Internal worker routes sit outside `/api` and are never proxied by the web app. */
export const INTERNAL_WORKER_PREFIX = '/internal/worker/v1';
export const WORKER_RESULT_PATH = `${INTERNAL_WORKER_PREFIX}/probe-results`;

export const WORKER_HEARTBEAT_PATH = `${INTERNAL_WORKER_PREFIX}/heartbeat`;

/** Health routes. Liveness never touches the database; readiness gates container health. */
export const LIVENESS_PATH = '/api/health/live';
export const READINESS_PATH = '/api/health/ready';

/**
 * The worker reports a heartbeat to the API at this interval after writing its
 * database heartbeat. The API keeps only heartbeats received by its own process,
 * so one left by a previous process can never satisfy readiness.
 */
export const WORKER_HEARTBEAT_INTERVAL_MS = 5_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 15_000;

export const WorkerHeartbeatReport = z.strictObject({
  workerId: z.string().min(1).max(200),
  bootId: z.uuid(),
  startedAt: z.iso.datetime({ offset: true }),
});
export type WorkerHeartbeatReport = z.infer<typeof WorkerHeartbeatReport>;

export const NotReadyReason = z.enum([
  'shutting_down',
  'database_unavailable',
  'database_check_failed',
  'schema_incompatible',
  'worker_heartbeat_missing',
  'worker_heartbeat_stale',
]);
export type NotReadyReason = z.infer<typeof NotReadyReason>;

export const ReadinessResponse = z.strictObject({
  ready: z.boolean(),
  reasons: z.array(NotReadyReason),
});
export type ReadinessResponse = z.infer<typeof ReadinessResponse>;

export const LivenessResponse = z.strictObject({
  live: z.literal(true),
});
export type LivenessResponse = z.infer<typeof LivenessResponse>;

/** Internal worker-to-API report; the API trusts only its persisted job record. */
export const WorkerResultReport = z.strictObject({
  jobId: z.uuid(),
  probeId: z.uuid(),
  result: WorkerResult,
});
export type WorkerResultReport = z.infer<typeof WorkerResultReport>;

export const WorkerResultAck = z.strictObject({
  contractVersion: z.literal(CONTRACT_VERSION),
  probe: PilotProbe,
  replayed: z.boolean(),
});
export type WorkerResultAck = z.infer<typeof WorkerResultAck>;

/** Transport-only SSE fixture frame; it carries no case or progress data. */
export const StreamFrame = z.strictObject({
  sequence: z.number().int().min(1),
  total: z.number().int().min(1),
  emittedAt: z.iso.datetime({ offset: true }),
});
export type StreamFrame = z.infer<typeof StreamFrame>;

// SPEC domain records: case, documents, evidence, policy pack and assessment.
export * from './domain/index.js';
export * from './workflow/index.js';
export * from './agent/index.js';
