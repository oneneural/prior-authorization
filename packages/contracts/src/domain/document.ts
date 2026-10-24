import { z } from 'zod';

import { SupplierExemption } from './case.js';
import { DocumentVersion, Identifier, IsoDate, ItemCode, NonEmptyText, OffsetTimestamp, Sha256Hex, UtcTimestamp } from './common.js';

export const DocumentKind = z.enum(['order', 'encounter', 'order_receipt', 'supplier_status', 'supporting_note']);
export type DocumentKind = z.infer<typeof DocumentKind>;

/**
 * Whether the source system let the lab read the document's content.
 * `restricted`: access denied, no bytes held. `unreadable`: bytes held but not
 * readable as a supported structured body. Neither says anything about whether
 * the underlying clinical fact exists (R09).
 */
export const AccessStatus = z.enum(['available', 'restricted', 'unreadable']);
export type AccessStatus = z.infer<typeof AccessStatus>;

export const MimeType = z.enum(['application/json', 'text/plain']);
export type MimeType = z.infer<typeof MimeType>;

export const SourceSystem = z.enum(['practitioner_record', 'supplier_intake', 'supplier_compliance']);
export type SourceSystem = z.infer<typeof SourceSystem>;

export const SyntheticProvenance = z.strictObject({
  origin: z.literal('authored_synthetic'),
  statement: NonEmptyText,
});
export type SyntheticProvenance = z.infer<typeof SyntheticProvenance>;

export const DocumentRef = z.strictObject({
  documentId: Identifier,
  version: DocumentVersion,
});
export type DocumentRef = z.infer<typeof DocumentRef>;

/**
 * Metadata for one immutable document version. `contentHash` is the SHA-256 of
 * the exact source bytes; it is `null` only when access is restricted and no
 * bytes are held. `subjectId` is `null` only for supplier-level records that
 * concern no beneficiary.
 */
export const Document = z
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
    syntheticProvenance: SyntheticProvenance,
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
export type Document = z.infer<typeof Document>;

// Structured JSON source bodies. Every key is required; `null` records that the
// source states no value, which is distinct from a malformed body (unreadable).

export const PersonReference = z.strictObject({
  name: NonEmptyText.nullable(),
  identifier: Identifier.nullable(),
});
export type PersonReference = z.infer<typeof PersonReference>;

/** Explicit time of a medical event, kept separate from its local date. */
export const EventTime = z.strictObject({
  timestamp: OffsetTimestamp,
  timeZone: NonEmptyText,
});
export type EventTime = z.infer<typeof EventTime>;

export const SourceRecordStatus = z.enum(['final', 'draft']);
export type SourceRecordStatus = z.infer<typeof SourceRecordStatus>;

/** Signature metadata only claims a signature; the lab never authenticates a signer. */
export const SignatureMetadata = z.strictObject({
  signerName: NonEmptyText,
  signedDate: IsoDate,
});
export type SignatureMetadata = z.infer<typeof SignatureMetadata>;

export const OrderBody = z.strictObject({
  schemaVersion: z.literal('pa.source.order.v1'),
  documentKind: z.literal('order'),
  synthetic: z.literal(true),
  status: SourceRecordStatus,
  beneficiary: PersonReference,
  orderDate: IsoDate.nullable(),
  orderTime: EventTime.nullable(),
  item: z.strictObject({
    description: NonEmptyText.nullable(),
    code: ItemCode.nullable(),
    quantity: z.int().min(1).nullable(),
  }),
  treatingPractitioner: PersonReference,
  signature: SignatureMetadata.nullable(),
});
export type OrderBody = z.infer<typeof OrderBody>;

export const EncounterBody = z.strictObject({
  schemaVersion: z.literal('pa.source.encounter.v1'),
  documentKind: z.literal('encounter'),
  synthetic: z.literal(true),
  status: SourceRecordStatus,
  beneficiary: PersonReference,
  encounterDate: IsoDate.nullable(),
  completionTime: EventTime.nullable(),
  practitioner: PersonReference,
  lcmpReport: z.strictObject({
    incorporated: z.boolean().nullable(),
    evaluationDate: IsoDate.nullable(),
  }),
  clinical: z.strictObject({
    diagnosisStatement: NonEmptyText.nullable(),
    mobilityLimitation: NonEmptyText.nullable(),
    lowerLevelDevices: NonEmptyText.nullable(),
    homeAccessibility: NonEmptyText.nullable(),
    abilityToOperate: NonEmptyText.nullable(),
  }),
  narrative: z.string(),
});
export type EncounterBody = z.infer<typeof EncounterBody>;

export const OrderReceiptBody = z.strictObject({
  schemaVersion: z.literal('pa.source.order-receipt.v1'),
  documentKind: z.literal('order_receipt'),
  synthetic: z.literal(true),
  beneficiary: PersonReference,
  orderReference: DocumentRef.nullable(),
  receivedAt: UtcTimestamp.nullable(),
  recordedByRole: NonEmptyText,
});
export type OrderReceiptBody = z.infer<typeof OrderReceiptBody>;

export const SupplierStatusBody = z.strictObject({
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
export type SupplierStatusBody = z.infer<typeof SupplierStatusBody>;

/** Free-text attachment. Only its stated beneficiary is mapped to evidence. */
export const SupportingNoteBody = z.strictObject({
  schemaVersion: z.literal('pa.source.supporting-note.v1'),
  documentKind: z.literal('supporting_note'),
  synthetic: z.literal(true),
  beneficiary: PersonReference,
  authoredDate: IsoDate.nullable(),
  title: NonEmptyText,
  text: z.string(),
});
export type SupportingNoteBody = z.infer<typeof SupportingNoteBody>;

/** A structured source body; anything that fails this parse is `unreadable`. */
export const SourceDocumentBody = z.discriminatedUnion('documentKind', [
  OrderBody,
  EncounterBody,
  OrderReceiptBody,
  SupplierStatusBody,
  SupportingNoteBody,
]);
export type SourceDocumentBody = z.infer<typeof SourceDocumentBody>;
