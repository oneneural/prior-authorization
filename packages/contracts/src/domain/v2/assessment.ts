import { z } from 'zod';

import { CaseRevision, Identifier, Sha256Hex } from '../common.js';
import { DocumentRef } from '../document.js';
import { AssessedState } from '../assessment.js';
import { FindingStatus, ResponsibleRole, RuleId, RuleSeverity } from '../policy.js';
import { compareCodeUnits, compareConditions, compareDocumentRefs, compareNullableText, conditionIdentity, FindingCondition } from './conditions.js';
import { EvidenceFactV2 } from './evidence.js';
import { ExactText } from './text.js';

const refKey = (ref: DocumentRef) => `${ref.documentId}@v${ref.version}`;

/**
 * `pa.finding.v3`: one finding per rule (D2). `conditions` lists every
 * non-pass condition that held, from every outcome of the rule, in canonical
 * order (`compareConditions`). The
 * status is that of the first pack outcome owning a held condition, so a pass
 * has no conditions and any other status has at least one. Each condition's
 * own status, responsible role and state effect are those its pack
 * declaration gives, also when they rank below the finding's status.
 * `documentRefs` keeps the parent convention C07 meaning.
 */
export const FindingV3 = z
  .strictObject({
    schemaVersion: z.literal('pa.finding.v3'),
    findingId: Identifier,
    ruleId: RuleId,
    status: FindingStatus,
    severity: RuleSeverity,
    evidenceFactIds: z.array(Identifier),
    documentRefs: z.array(DocumentRef),
    conditions: z.array(FindingCondition),
    explanation: ExactText,
    responsibleRole: ResponsibleRole,
    caseRevision: CaseRevision,
  })
  .superRefine((value, context) => {
    if (new Set(value.evidenceFactIds).size !== value.evidenceFactIds.length) {
      context.addIssue({ code: 'custom', path: ['evidenceFactIds'], message: 'evidence fact IDs must be unique' });
    }
    const refs = value.documentRefs.map(refKey);
    if (new Set(refs).size !== refs.length) {
      context.addIssue({ code: 'custom', path: ['documentRefs'], message: 'document references must be unique' });
    }
    value.conditions.forEach((condition, index) => {
      if (!condition.conditionKey.startsWith(`${value.ruleId}.`)) {
        context.addIssue({ code: 'custom', path: ['conditions', index, 'conditionKey'], message: 'condition belongs to another rule' });
      }
      const previous = value.conditions[index - 1];
      if (previous !== undefined && compareConditions(previous, condition) > 0) {
        context.addIssue({ code: 'custom', path: ['conditions', index], message: 'conditions must be in canonical order' });
      }
    });
    const identities = value.conditions.map(conditionIdentity);
    if (new Set(identities).size !== identities.length) {
      context.addIssue({ code: 'custom', path: ['conditions'], message: 'duplicate condition' });
    }
    if ((value.status === 'pass') !== (value.conditions.length === 0)) {
      context.addIssue({ code: 'custom', path: ['conditions'], message: 'a pass finding has no conditions; any other finding has at least one' });
    }
  });
export type FindingV3 = z.infer<typeof FindingV3>;

/**
 * `pa.assessment-result.v3`. Quarantine is by exact version (D3): another
 * version of a quarantined ID is unaffected. `supersededDocuments` lists every
 * supplied version that an applied registry relationship supersedes (C08),
 * whether or not it is also quarantined, because the relationship is metadata.
 * Neither a quarantined nor a superseded version contributes facts. A
 * quarantined version appears only in the quarantine list, the superseded list
 * and R02; only R02 and R09, which classify every supplied version, name a
 * superseded one. The legacy `pa.assessment-result.v2` is unchanged.
 */
export const AssessmentResultV3 = z
  .strictObject({
    schemaVersion: z.literal('pa.assessment-result.v3'),
    caseId: Identifier,
    caseRevision: CaseRevision,
    policyPackId: Identifier,
    policyPackSha256: Sha256Hex,
    state: AssessedState,
    findings: z.array(FindingV3),
    quarantinedDocuments: z.array(DocumentRef),
    supersededDocuments: z.array(DocumentRef),
    evidenceFacts: z.array(EvidenceFactV2),
  })
  .superRefine((value, context) => {
    const factIds = value.evidenceFacts.map((fact) => fact.factId);
    if (new Set(factIds).size !== factIds.length) {
      context.addIssue({ code: 'custom', path: ['evidenceFacts'], message: 'fact IDs must be unique' });
    }
    if (new Set(value.findings.map((finding) => finding.findingId)).size !== value.findings.length) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'finding IDs must be unique' });
    }
    if (new Set(value.findings.map((finding) => finding.ruleId)).size !== value.findings.length) {
      context.addIssue({ code: 'custom', path: ['findings'], message: 'each rule reports exactly one finding' });
    }
    const quarantined = new Set(value.quarantinedDocuments.map(refKey));
    if (quarantined.size !== value.quarantinedDocuments.length) {
      context.addIssue({ code: 'custom', path: ['quarantinedDocuments'], message: 'quarantined documents must be unique' });
    }
    const superseded = new Set(value.supersededDocuments.map(refKey));
    if (superseded.size !== value.supersededDocuments.length) {
      context.addIssue({ code: 'custom', path: ['supersededDocuments'], message: 'superseded documents must be unique' });
    }

    const known = new Set(factIds);
    value.findings.forEach((finding, index) => {
      if (finding.caseRevision !== value.caseRevision) {
        context.addIssue({ code: 'custom', path: ['findings', index, 'caseRevision'], message: 'finding is for another case revision' });
      }
      finding.evidenceFactIds.forEach((factId, factIndex) => {
        if (!known.has(factId)) {
          context.addIssue({ code: 'custom', path: ['findings', index, 'evidenceFactIds', factIndex], message: `unknown fact ${factId}` });
        }
      });
      const named = [...finding.documentRefs, ...finding.conditions.flatMap((condition) => condition.documentRefs)].map(refKey);
      if (finding.ruleId !== 'R02' && named.some((ref) => quarantined.has(ref))) {
        context.addIssue({ code: 'custom', path: ['findings', index], message: 'only R02 names a quarantined version' });
      }
      if (finding.ruleId !== 'R02' && finding.ruleId !== 'R09' && named.some((ref) => superseded.has(ref))) {
        context.addIssue({ code: 'custom', path: ['findings', index], message: 'only R02 and R09 name a superseded version' });
      }
      if (finding.ruleId === 'R02') {
        const listed = [...new Set(finding.documentRefs.map(refKey))].sort();
        if (JSON.stringify(listed) !== JSON.stringify([...quarantined].sort())) {
          context.addIssue({ code: 'custom', path: ['findings', index, 'documentRefs'], message: 'R02 names exactly the quarantined versions (C07)' });
        }
      }
    });
    value.evidenceFacts.forEach((fact, index) => {
      const ref = `${fact.documentId}@v${fact.documentVersion}`;
      if (quarantined.has(ref)) {
        context.addIssue({ code: 'custom', path: ['evidenceFacts', index], message: 'a quarantined version contributes no facts' });
      }
      if (superseded.has(ref)) {
        context.addIssue({ code: 'custom', path: ['evidenceFacts', index], message: 'a superseded version contributes no facts' });
      }
    });
  });
export type AssessmentResultV3 = z.infer<typeof AssessmentResultV3>;

// Explicit input rejection (D6). A rejection reports every reason of the first
// failing stage and nothing from later stages: input boundary (checked by the
// fixture or ingestion loader before any payload is parsed), then schema, then
// snapshot integrity. It carries no state, findings or facts. Reasons hold
// content-free locations only: a document reference when the metadata
// identity is valid, and a logical input pointer, never a host path or source
// text.

export const RejectionStage = z.enum(['input_boundary', 'schema', 'snapshot_integrity']);
export type RejectionStage = z.infer<typeof RejectionStage>;

export const REJECTION_CODES_BY_STAGE = {
  input_boundary: ['document_count_exceeded', 'path_outside_root', 'document_size_exceeded'],
  schema: [
    'case_invalid',
    'document_metadata_invalid',
    'policy_pack_invalid',
    'policy_pack_incomplete',
    'assessment_date_invalid',
    'assessment_date_mismatch',
  ],
  snapshot_integrity: [
    'duplicate_document_version',
    'restricted_document_has_bytes',
    'document_bytes_missing',
    'supersession_cross_document',
    'supersession_cross_kind',
    'supersession_cross_subject',
    'supersession_cycle',
  ],
} as const satisfies Record<RejectionStage, readonly string[]>;

export const RejectionCode = z.enum([
  ...REJECTION_CODES_BY_STAGE.input_boundary,
  ...REJECTION_CODES_BY_STAGE.schema,
  ...REJECTION_CODES_BY_STAGE.snapshot_integrity,
]);
export type RejectionCode = z.infer<typeof RejectionCode>;

/**
 * Pointer into the logical assessment input `{ case, assessmentDate,
 * policyPack, documents }`. A document is addressed by its caller-assigned
 * slot name (in fixtures, the metadata sidecar name without `.meta.json`, such
 * as `f01-order.v1`), then `metadata` or `payload`. No host path or source
 * text ever appears.
 */
export const LogicalInputPointer = z
  .string()
  .regex(
    /^(\/(case|assessmentDate|policyPack)(\/([^~/]|~[01])*)*|\/documents(\/[A-Za-z0-9][A-Za-z0-9._-]*(\/(metadata|payload)(\/([^~/]|~[01])*)*)?)?)$/,
    'must be a logical input pointer under /case, /assessmentDate, /policyPack or /documents',
  );
export type LogicalInputPointer = z.infer<typeof LogicalInputPointer>;

export const RejectionReason = z.strictObject({
  code: RejectionCode,
  /** `null` when the reason concerns no single document or its metadata identity is itself invalid. */
  documentRef: DocumentRef.nullable(),
  path: LogicalInputPointer.nullable(),
});
export type RejectionReason = z.infer<typeof RejectionReason>;

const SLOT = '[A-Za-z0-9][A-Za-z0-9._-]*';

/** Whether a reason names a document: always (`required`), never (`null`) or when its metadata identity parsed (`nullable`). */
export type RejectionRefRule = 'required' | 'null' | 'nullable';

/**
 * The frozen shape of each reason code: its document reference rule and its
 * exact path (`null`, or a pattern in which `<slot>` is a document slot name).
 */
export const REJECTION_REASON_SHAPES = {
  document_count_exceeded: { documentRef: 'null', path: '/documents' },
  path_outside_root: { documentRef: 'null', path: null },
  document_size_exceeded: { documentRef: 'null', path: '/documents/<slot>/payload' },
  case_invalid: { documentRef: 'null', path: '/case' },
  document_metadata_invalid: { documentRef: 'nullable', path: '/documents/<slot>/metadata' },
  policy_pack_invalid: { documentRef: 'null', path: '/policyPack' },
  policy_pack_incomplete: { documentRef: 'null', path: '/policyPack/rules' },
  assessment_date_invalid: { documentRef: 'null', path: '/assessmentDate' },
  assessment_date_mismatch: { documentRef: 'null', path: '/assessmentDate' },
  duplicate_document_version: { documentRef: 'required', path: '/documents/<slot>/metadata' },
  restricted_document_has_bytes: { documentRef: 'required', path: '/documents/<slot>/payload' },
  document_bytes_missing: { documentRef: 'required', path: '/documents/<slot>/payload' },
  supersession_cross_document: { documentRef: 'required', path: '/documents/<slot>/metadata/supersedes' },
  supersession_cross_kind: { documentRef: 'required', path: '/documents/<slot>/metadata/supersedes' },
  supersession_cross_subject: { documentRef: 'required', path: '/documents/<slot>/metadata/supersedes' },
  supersession_cycle: { documentRef: 'required', path: '/documents/<slot>/metadata/supersedes' },
} as const satisfies Record<RejectionCode, { documentRef: RejectionRefRule; path: string | null }>;

function pathMatches(template: string | null, path: string | null): boolean {
  if (template === null || path === null) {
    return template === path;
  }
  return new RegExp(`^${template.split('<slot>').join(SLOT)}$`).test(path);
}

/** Canonical reason order: code, then document (`null` first), then path (`null` first), all by UTF-16 code units. */
function compareReasons(a: RejectionReason, b: RejectionReason): number {
  const documents =
    a.documentRef === null || b.documentRef === null
      ? Number(b.documentRef === null) - Number(a.documentRef === null)
      : compareDocumentRefs(a.documentRef, b.documentRef);
  return compareCodeUnits(a.code, b.code) || documents || compareNullableText(a.path, b.path);
}

/** `pa.input-rejection.v1`: complete reason set of the first failing stage, each in its frozen shape, unique and in canonical order. */
export const InputRejection = z
  .strictObject({
    schemaVersion: z.literal('pa.input-rejection.v1'),
    stage: RejectionStage,
    reasons: z.array(RejectionReason).min(1),
  })
  .superRefine((value, context) => {
    const allowed: readonly string[] = REJECTION_CODES_BY_STAGE[value.stage];
    value.reasons.forEach((reason, index) => {
      if (!allowed.includes(reason.code)) {
        context.addIssue({ code: 'custom', path: ['reasons', index, 'code'], message: `${reason.code} is not a ${value.stage} reason` });
      }
      const shape: { documentRef: RejectionRefRule; path: string | null } = REJECTION_REASON_SHAPES[reason.code];
      if ((shape.documentRef === 'required' && reason.documentRef === null) || (shape.documentRef === 'null' && reason.documentRef !== null)) {
        context.addIssue({ code: 'custom', path: ['reasons', index, 'documentRef'], message: `${reason.code} documentRef must be ${shape.documentRef}` });
      }
      if (!pathMatches(shape.path, reason.path)) {
        context.addIssue({ code: 'custom', path: ['reasons', index, 'path'], message: `${reason.code} path must be ${shape.path ?? 'null'}` });
      }
      const previous = value.reasons[index - 1];
      if (previous !== undefined && compareReasons(previous, reason) >= 0) {
        context.addIssue({ code: 'custom', path: ['reasons', index], message: 'reasons must be unique and in canonical order' });
      }
    });
  });
export type InputRejection = z.infer<typeof InputRejection>;

/** `pa.assessment-outcome.v3`: an assessed result or an explicit rejection, never both and never a partial result. */
export const AssessmentOutcomeV3 = z.discriminatedUnion('outcome', [
  z.strictObject({ schemaVersion: z.literal('pa.assessment-outcome.v3'), outcome: z.literal('assessed'), result: AssessmentResultV3 }),
  z.strictObject({ schemaVersion: z.literal('pa.assessment-outcome.v3'), outcome: z.literal('rejected'), rejection: InputRejection }),
]);
export type AssessmentOutcomeV3 = z.infer<typeof AssessmentOutcomeV3>;
