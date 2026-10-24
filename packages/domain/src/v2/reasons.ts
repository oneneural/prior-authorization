import {
  AssessmentOutcomeV3,
  compareCodeUnits,
  compareDocumentRefs,
  compareNullableText,
  type DocumentRef,
  type RejectionCode,
  type RejectionReason,
  type RejectionStage,
} from '@pa/contracts';

// Content-free rejection reasons (D6). A reason holds a code, a document
// reference only where its frozen shape allows one, and a logical input
// pointer built from the caller's slot label: never a host path, a quoted
// value or an exception message.

export type RejectedOutcomeV3 = Extract<AssessmentOutcomeV3, { outcome: 'rejected' }>;

export const reasonOf = (code: RejectionCode, documentRef: DocumentRef | null, path: string | null): RejectionReason => ({
  code,
  documentRef: documentRef === null ? null : { documentId: documentRef.documentId, version: documentRef.version },
  path,
});

export const metadataPath = (slot: string) => `/documents/${slot}/metadata`;
export const payloadPath = (slot: string) => `/documents/${slot}/payload`;
export const supersedesPath = (slot: string) => `/documents/${slot}/metadata/supersedes`;

/** Canonical reason order: code, then document (`null` first, then ID by UTF-16 code units and version), then path (`null` first). */
export function compareReasons(a: RejectionReason, b: RejectionReason): number {
  const documents =
    a.documentRef === null || b.documentRef === null
      ? Number(b.documentRef === null) - Number(a.documentRef === null)
      : compareDocumentRefs(a.documentRef, b.documentRef);
  return compareCodeUnits(a.code, b.code) || documents || compareNullableText(a.path, b.path);
}

/** The unique reasons in canonical order. */
export function canonicalReasons(reasons: readonly RejectionReason[]): RejectionReason[] {
  const unique = new Map(reasons.map((reason) => [JSON.stringify([reason.code, reason.documentRef?.documentId ?? null, reason.documentRef?.version ?? null, reason.path]), reason]));
  return [...unique.values()].sort(compareReasons);
}

/**
 * A rejected `pa.assessment-outcome.v3` holding the complete canonical reason
 * set of one stage, validated against the frozen contract. An invalid envelope
 * is a defect in this module, never an input property, so it throws.
 */
export function rejectedOutcome(stage: RejectionStage, reasons: readonly RejectionReason[]): RejectedOutcomeV3 {
  const outcome: RejectedOutcomeV3 = {
    schemaVersion: 'pa.assessment-outcome.v3',
    outcome: 'rejected',
    rejection: { schemaVersion: 'pa.input-rejection.v1', stage, reasons: canonicalReasons(reasons) },
  };
  if (!AssessmentOutcomeV3.safeParse(outcome).success) {
    throw new Error(`the ${stage} rejection does not match the frozen reason shapes`);
  }
  return outcome;
}

/**
 * The content-free backstop: evaluation could not be represented by
 * the supplied pack, so every partial result is discarded. It names no rule,
 * status or key.
 */
export const backstopRejection = (): RejectedOutcomeV3 => rejectedOutcome('schema', [reasonOf('policy_pack_invalid', null, '/policyPack')]);
