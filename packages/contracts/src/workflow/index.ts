import { z } from 'zod';

import { AssessmentOutcomeV3 } from '../domain/v2/assessment.js';
import { DocumentExact } from '../domain/v2/document.js';
import { EvidenceFactV2 } from '../domain/v2/evidence.js';
import { FindingV3 } from '../domain/v2/assessment.js';
import { DocumentRef } from '../domain/document.js';

export const CASE_QUEUE = 'case-assessment';
export const CASE_WORKER_PATH = '/internal/worker/v1/case-jobs';
export const CASE_NOTICE = 'Synthetic data. Administrative review only. No payer submission.';

/** Exact UTF-8 JSON source text. Slots are logical labels, never filesystem paths. */
export const CaseSnapshot = z.strictObject({
  caseText: z.string().max(32_768),
  policyText: z.string().max(524_288),
  documents: z.array(z.strictObject({
    slot: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/),
    metadataText: z.string().max(16_384),
    payload: z.string().max(1_048_576).nullable(),
  })).max(50),
});
export type CaseSnapshot = z.infer<typeof CaseSnapshot>;
export const CaseJobPayload = z.strictObject({ caseId: z.string().min(1).max(160), revision: z.int().positive() });
export type CaseJobPayload = z.infer<typeof CaseJobPayload>;
export const CaseJobScope = z.strictObject({ jobId: z.uuid(), ...CaseJobPayload.shape, snapshot: CaseSnapshot });
export type CaseJobScope = z.infer<typeof CaseJobScope>;
export const CaseResultReport = z.strictObject({ ...CaseJobPayload.shape, outcome: AssessmentOutcomeV3 });
export type CaseResultReport = z.infer<typeof CaseResultReport>;
export const AssessCaseRequest = z.strictObject({ expectedRevision: z.int().positive() });

export const CasePacket = z.strictObject({
  schemaVersion: z.literal('pa.packet.v1'),
  packetId: z.string(),
  caseId: z.string(),
  caseRevision: z.int().positive(),
  policyPackId: z.string(),
  policyPackSha256: z.string().regex(/^[0-9a-f]{64}$/),
  includedDocumentRefs: z.array(DocumentRef),
  documents: z.array(z.strictObject({ metadata: DocumentExact, payload: z.string() })),
  evidenceFacts: z.array(EvidenceFactV2),
  findings: z.array(FindingV3),
  clinicalReviewRequired: z.literal(true),
  clinicalReviewStatus: z.literal('requires_qualified_review'),
  mode: z.literal('rules_only'),
  notice: z.literal(CASE_NOTICE),
  limitations: z.array(z.string()),
  packetHash: z.string().regex(/^[0-9a-f]{64}$/),
});
export type CasePacket = z.infer<typeof CasePacket>;

export * from './commands.js';
export * from './auth.js';
