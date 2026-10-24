import { CaseV2, DocumentExact, DocumentVersion, Identifier, IsoDate, PolicyPackV2, type RejectionReason, RuleId } from '@pa/contracts';

import { type AssessmentInputV2 } from './input.js';
import { EVALUATOR_INVENTORY_V2, type EvaluatorInventoryV2, packCoverageGaps } from './inventory.js';
import { metadataPath, reasonOf } from './reasons.js';

// The schema stage (D6): every reason for an invalid case, metadata sidecar,
// policy pack or assessment argument, reported together. A source body is not
// parsed here: an unparseable body is an R09 finding, never a rejection.

/** One version whose metadata parsed with the exact contract. */
export interface ValidatedDocumentV2 {
  slot: string;
  metadata: DocumentExact;
  payload: Uint8Array | null;
}

export interface ValidatedInputV2 {
  caseRecord: CaseV2;
  pack: PolicyPackV2;
  assessmentDate: string;
  documents: readonly ValidatedDocumentV2[];
}

export type SchemaCheck = { ok: true; value: ValidatedInputV2 } | { ok: false; reasons: RejectionReason[] };

const utf8 = new TextDecoder('utf-8', { fatal: true });

/** The JSON value of exact UTF-8 bytes, or `undefined` when they are not one. */
export function parseJsonBytes(bytes: Uint8Array): { value: unknown } | undefined {
  try {
    return { value: JSON.parse(utf8.decode(bytes)) as unknown };
  } catch {
    return undefined;
  }
}

/**
 * The pack check, in order: a pack that is not a valid
 * `pa.policy-pack.v2` is `policy_pack_invalid`; otherwise one missing R01 to
 * R10 rule is `policy_pack_incomplete`; otherwise a pack that does not cover
 * the evaluator inventory is `policy_pack_invalid`. At most one reason.
 */
export function checkPolicyPackV2(bytes: Uint8Array, inventory: EvaluatorInventoryV2 = EVALUATOR_INVENTORY_V2): { pack: PolicyPackV2 } | { reason: RejectionReason } {
  const json = parseJsonBytes(bytes);
  const parsed = json === undefined ? undefined : PolicyPackV2.safeParse(json.value);
  if (parsed?.success !== true) {
    return { reason: reasonOf('policy_pack_invalid', null, '/policyPack') };
  }
  const pack = parsed.data;
  if (RuleId.options.some((ruleId) => !pack.rules.some((rule) => rule.ruleId === ruleId))) {
    return { reason: reasonOf('policy_pack_incomplete', null, '/policyPack/rules') };
  }
  if (packCoverageGaps(pack, inventory).length > 0) {
    return { reason: reasonOf('policy_pack_invalid', null, '/policyPack') };
  }
  return { pack };
}

/** The metadata identity, only when both `documentId` and `version` parse. */
function identityOf(json: unknown): { documentId: string; version: number } | null {
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return null;
  }
  const { documentId, version } = json as Record<string, unknown>;
  const id = Identifier.safeParse(documentId);
  const number = DocumentVersion.safeParse(version);
  return id.success && number.success ? { documentId: id.data, version: number.data } : null;
}

export function validateSchemaV2(input: AssessmentInputV2, inventory: EvaluatorInventoryV2 = EVALUATOR_INVENTORY_V2): SchemaCheck {
  const reasons: RejectionReason[] = [];

  const caseJson = parseJsonBytes(input.caseBytes);
  const caseRecord = caseJson === undefined ? undefined : CaseV2.safeParse(caseJson.value);
  if (caseRecord?.success !== true) {
    reasons.push(reasonOf('case_invalid', null, '/case'));
  }

  const documents: ValidatedDocumentV2[] = [];
  for (const document of input.documents) {
    const json = parseJsonBytes(document.metadata);
    const metadata = json === undefined ? undefined : DocumentExact.safeParse(json.value);
    if (metadata?.success === true) {
      documents.push({ slot: document.slot, metadata: metadata.data, payload: document.payload });
    } else {
      reasons.push(reasonOf('document_metadata_invalid', json === undefined ? null : identityOf(json.value), metadataPath(document.slot)));
    }
  }

  const pack = checkPolicyPackV2(input.policyPackBytes, inventory);
  if ('reason' in pack) {
    reasons.push(pack.reason);
  }

  // A mismatch is judged only when both the argument and the case are valid.
  const date = IsoDate.safeParse(input.assessmentDate);
  if (!date.success) {
    reasons.push(reasonOf('assessment_date_invalid', null, '/assessmentDate'));
  } else if (caseRecord?.success === true && date.data !== caseRecord.data.assessmentDate) {
    reasons.push(reasonOf('assessment_date_mismatch', null, '/assessmentDate'));
  }

  if (reasons.length > 0 || caseRecord?.success !== true || 'reason' in pack) {
    return { ok: false, reasons };
  }
  return { ok: true, value: { caseRecord: caseRecord.data, pack: pack.pack, assessmentDate: input.assessmentDate, documents } };
}
