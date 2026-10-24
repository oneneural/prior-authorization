import { z } from 'zod';

import { SupplierExemption } from '../case.js';
import { DocumentVersion, Identifier, IsoDate, ItemCode, OffsetTimestamp, Sha256Hex, UtcTimestamp } from '../common.js';
import { AccessStatus, DocumentKind, DocumentRef, MimeType, SourceRecordStatus, SourceSystem } from '../document.js';
import { ExactText } from './text.js';

// Exact (non-transforming) parsers for the unchanged `pa.document.v1` metadata
// and `pa.source.*.v1` body formats (D1). The wire formats and the set of
// accepted inputs are identical to the legacy schemas: fields that required
// nonblank text use `ExactText`, and fields that were unrestricted strings
// (`narrative`, `text`) still accept empty or whitespace-only text. Only the
// parsed output differs: nothing is trimmed. The literals are deliberately the
// v1 literals, so a consumer chooses the exact parser explicitly; it never
// switches parsers by reading `schemaVersion`.

export const SyntheticProvenanceExact = z.strictObject({
  origin: z.literal('authored_synthetic'),
  statement: ExactText,
});
export type SyntheticProvenanceExact = z.infer<typeof SyntheticProvenanceExact>;

/**
 * `pa.document.v1` metadata, parsed without transformation. `supersedes` is
 * the case-scoped registry relationship of convention C08: trusted caller-owned
 * metadata, never taken from a document body.
 */
export const DocumentExact = z
  .strictObject({
    schemaVersion: z.literal('pa.document.v1'),
    documentId: Identifier,
    version: DocumentVersion,
    subjectId: Identifier.nullable(),
    kind: DocumentKind,
    contentHash: Sha256Hex.nullable(),
    mimeType: MimeType,
    sourceSystem: SourceSystem,
    receivedAt: UtcTimestamp,
    authoredAt: IsoDate.nullable(),
    supersedes: DocumentRef.nullable(),
    syntheticProvenance: SyntheticProvenanceExact,
    accessStatus: AccessStatus,
  })
  .superRefine((value, context) => {
    if ((value.accessStatus === 'restricted') !== (value.contentHash === null)) {
      context.addIssue({ code: 'custom', path: ['contentHash'], message: 'contentHash is null exactly when access is restricted' });
    }
    if ((value.kind === 'supplier_status') !== (value.subjectId === null)) {
      context.addIssue({ code: 'custom', path: ['subjectId'], message: 'subjectId is null exactly for supplier_status records' });
    }
    if (value.supersedes !== null && value.supersedes.documentId === value.documentId && value.supersedes.version >= value.version) {
      context.addIssue({ code: 'custom', path: ['supersedes'], message: 'a version can only supersede an earlier version' });
    }
  });
export type DocumentExact = z.infer<typeof DocumentExact>;

export const PersonReferenceExact = z.strictObject({
  name: ExactText.nullable(),
  identifier: Identifier.nullable(),
});
export type PersonReferenceExact = z.infer<typeof PersonReferenceExact>;

export const EventTimeExact = z.strictObject({
  timestamp: OffsetTimestamp,
  timeZone: ExactText,
});
export type EventTimeExact = z.infer<typeof EventTimeExact>;

/** Signature metadata only claims a signature; the lab never authenticates a signer. */
export const SignatureMetadataExact = z.strictObject({
  signerName: ExactText,
  signedDate: IsoDate,
});
export type SignatureMetadataExact = z.infer<typeof SignatureMetadataExact>;

export const OrderBodyExact = z.strictObject({
  schemaVersion: z.literal('pa.source.order.v1'),
  documentKind: z.literal('order'),
  synthetic: z.literal(true),
  status: SourceRecordStatus,
  beneficiary: PersonReferenceExact,
  orderDate: IsoDate.nullable(),
  orderTime: EventTimeExact.nullable(),
  item: z.strictObject({
    description: ExactText.nullable(),
    code: ItemCode.nullable(),
    quantity: z.int().min(1).nullable(),
  }),
  treatingPractitioner: PersonReferenceExact,
  signature: SignatureMetadataExact.nullable(),
});
export type OrderBodyExact = z.infer<typeof OrderBodyExact>;

export const EncounterBodyExact = z.strictObject({
  schemaVersion: z.literal('pa.source.encounter.v1'),
  documentKind: z.literal('encounter'),
  synthetic: z.literal(true),
  status: SourceRecordStatus,
  beneficiary: PersonReferenceExact,
  encounterDate: IsoDate.nullable(),
  completionTime: EventTimeExact.nullable(),
  practitioner: PersonReferenceExact,
  lcmpReport: z.strictObject({
    incorporated: z.boolean().nullable(),
    evaluationDate: IsoDate.nullable(),
  }),
  clinical: z.strictObject({
    diagnosisStatement: ExactText.nullable(),
    mobilityLimitation: ExactText.nullable(),
    lowerLevelDevices: ExactText.nullable(),
    homeAccessibility: ExactText.nullable(),
    abilityToOperate: ExactText.nullable(),
  }),
  // Unrestricted in v1 and still unrestricted: empty or blank text is accepted.
  narrative: z.string(),
});
export type EncounterBodyExact = z.infer<typeof EncounterBodyExact>;

export const OrderReceiptBodyExact = z.strictObject({
  schemaVersion: z.literal('pa.source.order-receipt.v1'),
  documentKind: z.literal('order_receipt'),
  synthetic: z.literal(true),
  beneficiary: PersonReferenceExact,
  orderReference: DocumentRef.nullable(),
  receivedAt: UtcTimestamp.nullable(),
  recordedByRole: ExactText,
});
export type OrderReceiptBodyExact = z.infer<typeof OrderReceiptBodyExact>;

/** The supplier status body has no free text; it is restated here so the exact union is complete. */
export const SupplierStatusBodyExact = z.strictObject({
  schemaVersion: z.literal('pa.source.supplier-status.v1'),
  documentKind: z.literal('supplier_status'),
  synthetic: z.literal(true),
  supplierId: Identifier,
  status: SupplierExemption,
  established: z.boolean().nullable(),
  newEnrollment: z.boolean().nullable(),
  ownershipChange: z.boolean().nullable(),
  effectiveFrom: IsoDate.nullable(),
  effectiveTo: IsoDate.nullable(),
});
export type SupplierStatusBodyExact = z.infer<typeof SupplierStatusBodyExact>;

export const SupportingNoteBodyExact = z.strictObject({
  schemaVersion: z.literal('pa.source.supporting-note.v1'),
  documentKind: z.literal('supporting_note'),
  synthetic: z.literal(true),
  beneficiary: PersonReferenceExact,
  authoredDate: IsoDate.nullable(),
  title: ExactText,
  // Unrestricted in v1 and still unrestricted: empty or blank text is accepted.
  text: z.string(),
});
export type SupportingNoteBodyExact = z.infer<typeof SupportingNoteBodyExact>;

/** Exact structured source body; anything that fails this parse is `unreadable` (R09 `body_invalid`). */
export const SourceDocumentBodyExact = z.discriminatedUnion('documentKind', [
  OrderBodyExact,
  EncounterBodyExact,
  OrderReceiptBodyExact,
  SupplierStatusBodyExact,
  SupportingNoteBodyExact,
]);
export type SourceDocumentBodyExact = z.infer<typeof SourceDocumentBodyExact>;
