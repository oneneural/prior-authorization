import { sql } from 'drizzle-orm';
import { bigserial, boolean, check, foreignKey, integer, jsonb, primaryKey, pgSchema, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import type { AgentTraceStep, AgentVersions, AssessmentOutcomeV3, CasePacket, CaseSnapshot, ModelIdentity, RequestProposal, RevisionBinding, WorkerResult } from '@pa/contracts';

// Application data owned by the API role. The worker role has no grant here.
export const appSchema = pgSchema('pa_app');

export const pilotProbeStatus = appSchema.enum('pilot_probe_status', ['queued', 'completed']);

export const pilotProbes = appSchema.table(
  'pilot_probes',
  {
    probeId: uuid('probe_id').primaryKey(),
    idempotencyKey: text('idempotency_key').notNull().unique(),
    requestHash: text('request_hash').notNull(),
    label: text('label').notNull(),
    synthetic: boolean('synthetic').notNull().default(true),
    status: pilotProbeStatus('status').notNull().default('queued'),
    jobId: uuid('job_id').notNull().unique(),
    workerResult: jsonb('worker_result').$type<WorkerResult>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (table) => [
    check('pilot_probes_synthetic_only', sql`${table.synthetic}`),
    check(
      'pilot_probes_completion_consistent',
      sql`(${table.status} = 'completed') = (${table.workerResult} IS NOT NULL AND ${table.completedAt} IS NOT NULL)`,
    ),
  ],
);

// Worker-owned liveness data. The API role has no grant here.
export const workerSchema = pgSchema('pa_worker');

export const workerHeartbeats = workerSchema.table('worker_heartbeats', {
  workerId: text('worker_id').primaryKey(),
  bootId: uuid('boot_id').notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull(),
  lastJobId: uuid('last_job_id'),
});

// Immutable source objects are content addressed. Only the API may insert/read.
export const caseBlobs = appSchema.table('case_blobs', {
  hash: text('hash').primaryKey(),
  content: text('content').notNull(),
}, (table) => [check('case_blobs_hash_check', sql`${table.hash} ~ '^[0-9a-f]{64}$'`)]);

export const cases = appSchema.table('cases', {
  caseId: text('case_id').primaryKey(),
  ownerId: text('owner_id').notNull(),
  revision: integer('revision').notNull(),
  state: text('state').notNull().default('intake'),
  currentJobId: uuid('current_job_id'),
}, (table) => [check('cases_revision_check', sql`${table.revision} > 0`)]);

export const caseDocuments = appSchema.table('case_documents', {
  caseId: text('case_id').notNull().references(() => cases.caseId),
  documentId: text('document_id').notNull(),
  version: integer('version').notNull(),
  metadataText: text('metadata_text').notNull(),
  blobHash: text('blob_hash').references(() => caseBlobs.hash),
}, (table) => [primaryKey({ columns: [table.caseId, table.documentId, table.version] }), check('case_documents_version_check', sql`${table.version} > 0`)]);

export const caseRevisions = appSchema.table('case_revisions', {
  caseId: text('case_id').notNull().references(() => cases.caseId),
  revision: integer('revision').notNull(),
  caseText: text('case_text').notNull(),
  policyHash: text('policy_hash').notNull().references(() => caseBlobs.hash),
  documentRefs: jsonb('document_refs').$type<{ slot: string; documentId: string; version: number }[]>().notNull(),
}, (table) => [primaryKey({ columns: [table.caseId, table.revision] }), check('case_revisions_revision_check', sql`${table.revision} > 0`)]);

export const caseAssessments = appSchema.table('case_assessments', {
  jobId: uuid('job_id').primaryKey(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  revision: integer('revision').notNull(),
  outcome: jsonb('outcome').$type<AssessmentOutcomeV3>(),
  packet: jsonb('packet').$type<CasePacket>(),
}, (table) => [foreignKey({ columns: [table.caseId, table.revision], foreignColumns: [caseRevisions.caseId, caseRevisions.revision], name: 'case_assessments_case_id_revision_fkey' })]);

export const caseEvents = appSchema.table('case_events', {
  sequence: bigserial('sequence', { mode: 'number' }).primaryKey(),
  eventId: uuid('event_id').notNull().unique(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  type: text('type').notNull(),
  actor: text('actor').notNull(),
  inputRevision: integer('input_revision').notNull(),
  payloadHash: text('payload_hash').notNull(),
  correlationId: uuid('correlation_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
});

export const documentRequests = appSchema.table('document_requests', {
  requestId: uuid('request_id').primaryKey(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  caseRevision: integer('case_revision').notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  proposalHash: text('proposal_hash').notNull(),
  findingId: text('finding_id').notNull(),
  ruleId: text('rule_id').notNull(),
  conditionKeys: jsonb('condition_keys').$type<string[]>().notNull(),
  payload: jsonb('payload').$type<RequestProposal & { body: string; caseId: string }>().notNull(),
  contentHash: text('content_hash').notNull(),
  state: text('state').notNull().default('draft'),
  approvedPayload: jsonb('approved_payload').$type<RequestProposal & { body: string; caseId: string }>(),
  approvedBy: text('approved_by'),
  approvedAt: timestamp('approved_at', { withTimezone: true }),
}, (table) => [unique('document_requests_case_key').on(table.caseId, table.idempotencyKey)]);

export const localReceipts = appSchema.table('local_receipts', {
  receiptId: uuid('receipt_id').primaryKey(),
  requestId: uuid('request_id').notNull().unique().references(() => documentRequests.requestId),
  contentHash: text('content_hash').notNull(),
  mode: text('mode').notNull().default('scripted_fixture'),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }).notNull().defaultNow(),
});

export const workflowCommands = appSchema.table('workflow_commands', {
  eventId: uuid('event_id').primaryKey(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  operation: text('operation').notNull(),
  payloadHash: text('payload_hash').notNull(),
  result: jsonb('result').$type<Record<string, unknown>>().notNull(),
});

export const workflowResponses = appSchema.table('workflow_responses', {
  eventId: uuid('event_id').primaryKey(),
  requestId: uuid('request_id').notNull().references(() => documentRequests.requestId),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  fixtureEvent: text('fixture_event').notNull(),
  snapshot: jsonb('snapshot').$type<CaseSnapshot>().notNull(),
  disposition: text('disposition').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const reviewDecisions = appSchema.table('review_decisions', {
  decisionId: uuid('decision_id').primaryKey(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  actorId: text('actor_id').notNull(),
  role: text('role').notNull(),
  binding: jsonb('binding').$type<RevisionBinding>().notNull(),
  decision: text('decision').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

// Investigation runs. The run records scope, versions and the sanitized trace;
// LangGraph checkpoints hold progress only and never administrative truth.
export const agentRuns = appSchema.table('agent_runs', {
  runId: uuid('run_id').primaryKey(),
  caseId: text('case_id').notNull().references(() => cases.caseId),
  caseRevision: integer('case_revision').notNull(),
  binding: jsonb('binding').$type<RevisionBinding>().notNull(),
  provider: text('provider').notNull(),
  label: text('label').notNull(),
  recordingId: text('recording_id'),
  versions: jsonb('versions').$type<AgentVersions>().notNull(),
  threadId: text('thread_id').notNull().unique(),
  state: text('state').notNull().default('queued'),
  pendingJobId: uuid('pending_job_id'),
  // The worker claim that moved the pending job to running; a repeated claim with it is a retry.
  claimId: uuid('claim_id'),
  stopReason: text('stop_reason'),
  failureCode: text('failure_code'),
  modelIdentity: jsonb('model_identity').$type<ModelIdentity>(),
  trace: jsonb('trace').$type<AgentTraceStep[]>().notNull().default([]),
  reviewEventId: uuid('review_event_id'),
  outcome: jsonb('outcome').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Validated model proposals. Only `valid` rows can be accepted, and acceptance is revision bound. */
export const agentProposals = appSchema.table('agent_proposals', {
  proposalId: uuid('proposal_id').primaryKey(),
  runId: uuid('run_id').notNull().references(() => agentRuns.runId),
  proposalKey: text('proposal_key').notNull(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>(),
  payloadHash: text('payload_hash').notNull(),
  status: text('status').notNull(),
  code: text('code'),
  review: text('review').notNull().default('pending'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [unique('agent_proposals_run_key').on(table.runId, table.proposalKey)]);

// Better Auth tables (the API's session store). `role` and `team_id` are
// server-assigned demo memberships; the auth routes never accept them as input.
export const authUsers = appSchema.table('auth_users', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  image: text('image'),
  role: text('role').notNull(),
  teamId: text('team_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authSessions = appSchema.table('auth_sessions', {
  id: text('id').primaryKey(),
  token: text('token').notNull().unique(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authAccounts = appSchema.table('auth_accounts', {
  id: text('id').primaryKey(),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  userId: text('user_id').notNull().references(() => authUsers.id, { onDelete: 'cascade' }),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  idToken: text('id_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const authVerifications = appSchema.table('auth_verifications', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
