import { z } from 'zod';

import { EvidenceFactV2 } from '../domain/v2/evidence.js';
import { Identifier, Sha256Hex } from '../domain/common.js';
const IdempotencyKey = z.string().regex(/^[A-Za-z0-9_-]{16,128}$/);

export const WorkflowJobPayload = z.strictObject({ requestId: z.uuid(), revision: z.int().positive() });
export const WORKFLOW_QUEUE = 'local-request';
export const WORKFLOW_WORKER_PATH = '/internal/worker/v1/workflow';
export const RevisionBinding = z.strictObject({
  expectedRevision: z.int().positive(), sourceRevisionHash: Sha256Hex,
  policyPackSha256: Sha256Hex, packetHash: Sha256Hex,
});
export type RevisionBinding = z.infer<typeof RevisionBinding>;
export const RequestTemplate = z.enum(['existing_order', 'existing_encounter', 'existing_receipt']);
export const RecipientRole = z.enum(['practitioner_records', 'supplier_records']);
export const RequestProposal = z.strictObject({
  ...RevisionBinding.shape, findingId: Identifier, templateId: RequestTemplate, recipientRole: RecipientRole,
});
export type RequestProposal = z.infer<typeof RequestProposal>;
export const ProposeRequestCommand = z.strictObject({ ...RequestProposal.shape, eventId: z.uuid(), idempotencyKey: IdempotencyKey });
export type ProposeRequestCommand = z.infer<typeof ProposeRequestCommand>;
export const ApproveRequestCommand = z.strictObject({ ...RevisionBinding.shape, eventId: z.uuid(), contentHash: Sha256Hex });
export type ApproveRequestCommand = z.infer<typeof ApproveRequestCommand>;
export const ReviewPacketCommand = z.strictObject({
  ...RevisionBinding.shape, eventId: z.uuid(), decision: z.enum(['accept_for_review', 'return']), reason: z.string().trim().min(1).max(2000),
});
export type ReviewPacketCommand = z.infer<typeof ReviewPacketCommand>;
export const CaseActionCommand = z.strictObject({ eventId: z.uuid(), expectedRevision: z.int().positive() });
export type CaseActionCommand = z.infer<typeof CaseActionCommand>;
export const FixtureResponseCommand = z.strictObject({
  ...CaseActionCommand.shape, requestId: z.uuid(), fixtureEvent: z.enum(['archive_f01', 'archive_f05b']),
});
export type FixtureResponseCommand = z.infer<typeof FixtureResponseCommand>;
/** Closes a delivered request whose reply did not resolve the rule, so a follow-up can be drafted. */
export const CloseRequestCommand = z.strictObject({ eventId: z.uuid() });
export type CloseRequestCommand = z.infer<typeof CloseRequestCommand>;
/** Proposals carry provenance and revisions, never execution or approval authority. */
export const FactProposal = z.strictObject({
  ...RevisionBinding.shape, fact: EvidenceFactV2, sourceContentHash: Sha256Hex,
});
export type FactProposal = z.infer<typeof FactProposal>;
export const WorkflowFailure = z.strictObject({ revision: z.int().positive(), code: z.enum(['permanent_tool_failure', 'tool_retries_exhausted']) });
