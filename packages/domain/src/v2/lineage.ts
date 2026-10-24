import { type DocumentExact, type DocumentRef, type RejectionReason } from '@pa/contracts';

import { metadataPath, payloadPath, reasonOf, supersedesPath } from './reasons.js';
import { type ValidatedInputV2 } from './schema.js';

// Snapshot integrity (D6) and supersession lineage (C08, D5). Both read the
// complete validated snapshot, so neither depends on the order of the
// supplied array. Lineage is trusted caller metadata: a body never creates,
// changes or cancels a relationship, and none is inferred from a larger
// version number.

export const refKey = (ref: DocumentRef) => `${ref.documentId}@v${ref.version}`;
export const refOf = (metadata: DocumentExact): DocumentRef => ({ documentId: metadata.documentId, version: metadata.version });

/**
 * Every snapshot integrity reason. Duplicate, restricted-with-bytes and
 * missing-bytes checks always run; the supersession checks are skipped when
 * any duplicate holds, because edges are then ill-defined. A reference to
 * another document ID rejects whether or not that target is supplied
 * (cross-document reference decision, answer 4). Kind and subject are compared for every supplied
 * target, including the target of a cross-document reference; an absent
 * target is not compared. Every edge points to a strictly earlier version
 * (schema), so `supersession_cycle` cannot hold.
 */
export function snapshotIntegrityReasons(input: ValidatedInputV2): RejectionReason[] {
  const reasons: RejectionReason[] = [];
  const byRef = new Map<string, ValidatedInputV2['documents'][number][]>();
  for (const document of input.documents) {
    const key = refKey(refOf(document.metadata));
    byRef.set(key, [...(byRef.get(key) ?? []), document]);
  }

  for (const document of input.documents) {
    const ref = refOf(document.metadata);
    if ((byRef.get(refKey(ref)) ?? []).length > 1) {
      reasons.push(reasonOf('duplicate_document_version', ref, metadataPath(document.slot)));
    }
    const restricted = document.metadata.accessStatus === 'restricted';
    if (restricted && document.payload !== null) {
      reasons.push(reasonOf('restricted_document_has_bytes', ref, payloadPath(document.slot)));
    }
    if (!restricted && document.payload === null) {
      reasons.push(reasonOf('document_bytes_missing', ref, payloadPath(document.slot)));
    }
  }
  if (reasons.some((reason) => reason.code === 'duplicate_document_version')) {
    return reasons;
  }

  const subjectId = input.caseRecord.subjectId;
  for (const document of input.documents) {
    const { metadata } = document;
    if (metadata.supersedes === null) {
      continue;
    }
    const ref = refOf(metadata);
    if (metadata.supersedes.documentId !== metadata.documentId) {
      reasons.push(reasonOf('supersession_cross_document', ref, supersedesPath(document.slot)));
    }
    const target = byRef.get(refKey(metadata.supersedes))?.[0]?.metadata;
    if (target === undefined) {
      continue;
    }
    if (target.kind !== metadata.kind) {
      reasons.push(reasonOf('supersession_cross_kind', ref, supersedesPath(document.slot)));
    }
    // Supplier status records have no subject and may supersede each other.
    const bothSubjectless = metadata.subjectId === null && target.subjectId === null;
    if (!bothSubjectless && (metadata.subjectId !== target.subjectId || metadata.subjectId !== subjectId)) {
      reasons.push(reasonOf('supersession_cross_subject', ref, supersedesPath(document.slot)));
    }
  }
  return reasons;
}

/**
 * The superseded versions of a snapshot that passed integrity: every supplied
 * target of a `supersedes` edge. An edge applies whatever the superseder's
 * own usability, so older evidence is never made current again; an edge whose
 * target is not supplied has no effect.
 */
export function supersededKeys(input: ValidatedInputV2): Set<string> {
  const supplied = new Set(input.documents.map((document) => refKey(refOf(document.metadata))));
  const superseded = new Set<string>();
  for (const { metadata } of input.documents) {
    if (metadata.supersedes?.documentId === metadata.documentId && supplied.has(refKey(metadata.supersedes))) {
      superseded.add(refKey(metadata.supersedes));
    }
  }
  return superseded;
}
