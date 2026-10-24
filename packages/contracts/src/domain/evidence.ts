import { z } from 'zod';

import { DocumentVersion, Identifier, JsonPointer, NonEmptyText } from './common.js';
import { type DocumentKind } from './document.js';

/**
 * Evidence field vocabulary. Each field names one value at a fixed JSON Pointer
 * in one structured source body kind (see EVIDENCE_FIELD_SOURCES). The
 * `clinical.*` fields are evidence candidates for qualified review (R06) and
 * never support or refute medical necessity on their own.
 */
export const EvidenceField = z.enum([
  'order.status',
  'order.beneficiary_name',
  'order.beneficiary_identifier',
  'order.date',
  'order.timestamp',
  'order.item_description',
  'order.item_code',
  'order.quantity',
  'order.practitioner_name',
  'order.practitioner_identifier',
  'order.signature_signer_name',
  'order.signature_date',
  'encounter.status',
  'encounter.beneficiary_name',
  'encounter.beneficiary_identifier',
  'encounter.date',
  'encounter.completion_timestamp',
  'encounter.practitioner_name',
  'encounter.practitioner_identifier',
  'encounter.lcmp_report_incorporated',
  'encounter.lcmp_evaluation_date',
  'clinical.diagnosis_statement',
  'clinical.mobility_limitation',
  'clinical.lower_level_devices',
  'clinical.home_accessibility',
  'clinical.ability_to_operate',
  'receipt.beneficiary_name',
  'receipt.beneficiary_identifier',
  'receipt.order_document_id',
  'receipt.order_document_version',
  'receipt.received_at',
  'supplier.id',
  'supplier.status',
  'supplier.established',
  'supplier.new_enrollment',
  'supplier.ownership_change',
  'supplier.effective_from',
  'supplier.effective_to',
  'note.beneficiary_name',
  'note.beneficiary_identifier',
]);
export type EvidenceField = z.infer<typeof EvidenceField>;

/** Clinical fields that R06 routes to qualified review. */
export const CLINICAL_EVIDENCE_FIELDS = EvidenceField.options.filter((field) => field.startsWith('clinical.'));

/**
 * Where each field's value lives. A fact exists for a field only when the
 * pointer resolves to a non-null value in a body of the named kind.
 */
export const EVIDENCE_FIELD_SOURCES: Readonly<Record<EvidenceField, { readonly documentKind: DocumentKind; readonly pointer: string }>> = {
  'order.status': { documentKind: 'order', pointer: '/status' },
  'order.beneficiary_name': { documentKind: 'order', pointer: '/beneficiary/name' },
  'order.beneficiary_identifier': { documentKind: 'order', pointer: '/beneficiary/identifier' },
  'order.date': { documentKind: 'order', pointer: '/orderDate' },
  'order.timestamp': { documentKind: 'order', pointer: '/orderTime/timestamp' },
  'order.item_description': { documentKind: 'order', pointer: '/item/description' },
  'order.item_code': { documentKind: 'order', pointer: '/item/code' },
  'order.quantity': { documentKind: 'order', pointer: '/item/quantity' },
  'order.practitioner_name': { documentKind: 'order', pointer: '/treatingPractitioner/name' },
  'order.practitioner_identifier': { documentKind: 'order', pointer: '/treatingPractitioner/identifier' },
  'order.signature_signer_name': { documentKind: 'order', pointer: '/signature/signerName' },
  'order.signature_date': { documentKind: 'order', pointer: '/signature/signedDate' },
  'encounter.status': { documentKind: 'encounter', pointer: '/status' },
  'encounter.beneficiary_name': { documentKind: 'encounter', pointer: '/beneficiary/name' },
  'encounter.beneficiary_identifier': { documentKind: 'encounter', pointer: '/beneficiary/identifier' },
  'encounter.date': { documentKind: 'encounter', pointer: '/encounterDate' },
  'encounter.completion_timestamp': { documentKind: 'encounter', pointer: '/completionTime/timestamp' },
  'encounter.practitioner_name': { documentKind: 'encounter', pointer: '/practitioner/name' },
  'encounter.practitioner_identifier': { documentKind: 'encounter', pointer: '/practitioner/identifier' },
  'encounter.lcmp_report_incorporated': { documentKind: 'encounter', pointer: '/lcmpReport/incorporated' },
  'encounter.lcmp_evaluation_date': { documentKind: 'encounter', pointer: '/lcmpReport/evaluationDate' },
  'clinical.diagnosis_statement': { documentKind: 'encounter', pointer: '/clinical/diagnosisStatement' },
  'clinical.mobility_limitation': { documentKind: 'encounter', pointer: '/clinical/mobilityLimitation' },
  'clinical.lower_level_devices': { documentKind: 'encounter', pointer: '/clinical/lowerLevelDevices' },
  'clinical.home_accessibility': { documentKind: 'encounter', pointer: '/clinical/homeAccessibility' },
  'clinical.ability_to_operate': { documentKind: 'encounter', pointer: '/clinical/abilityToOperate' },
  'receipt.beneficiary_name': { documentKind: 'order_receipt', pointer: '/beneficiary/name' },
  'receipt.beneficiary_identifier': { documentKind: 'order_receipt', pointer: '/beneficiary/identifier' },
  'receipt.order_document_id': { documentKind: 'order_receipt', pointer: '/orderReference/documentId' },
  'receipt.order_document_version': { documentKind: 'order_receipt', pointer: '/orderReference/version' },
  'receipt.received_at': { documentKind: 'order_receipt', pointer: '/receivedAt' },
  'supplier.id': { documentKind: 'supplier_status', pointer: '/supplierId' },
  'supplier.status': { documentKind: 'supplier_status', pointer: '/status' },
  'supplier.established': { documentKind: 'supplier_status', pointer: '/established' },
  'supplier.new_enrollment': { documentKind: 'supplier_status', pointer: '/newEnrollment' },
  'supplier.ownership_change': { documentKind: 'supplier_status', pointer: '/ownershipChange' },
  'supplier.effective_from': { documentKind: 'supplier_status', pointer: '/effectiveFrom' },
  'supplier.effective_to': { documentKind: 'supplier_status', pointer: '/effectiveTo' },
  'note.beneficiary_name': { documentKind: 'supporting_note', pointer: '/beneficiary/name' },
  'note.beneficiary_identifier': { documentKind: 'supporting_note', pointer: '/beneficiary/identifier' },
};

/** Exact source location: document, version and JSON Pointer into its body. */
export const EvidenceCitation = z.strictObject({
  documentId: Identifier,
  documentVersion: DocumentVersion,
  locator: JsonPointer,
});
export type EvidenceCitation = z.infer<typeof EvidenceCitation>;

export const ExtractionMethod = z.enum(['deterministic', 'model']);
export type ExtractionMethod = z.infer<typeof ExtractionMethod>;

export const FactReviewStatus = z.enum(['proposed', 'accepted', 'rejected']);
export type FactReviewStatus = z.infer<typeof FactReviewStatus>;

/**
 * One extracted value with its exact source. `originalText` is the source text
 * at the locator (a JSON string's content, or the JSON text of a number or
 * boolean). Deterministic extraction has no confidence; a model proposal must
 * state one. The locator must be the field's fixed pointer.
 */
export const EvidenceFact = z
  .strictObject({
    schemaVersion: z.literal('pa.evidence-fact.v1'),
    factId: Identifier,
    field: EvidenceField,
    value: z.union([z.string(), z.number(), z.boolean()]),
    documentId: Identifier,
    documentVersion: DocumentVersion,
    locator: JsonPointer,
    originalText: NonEmptyText,
    extractionMethod: ExtractionMethod,
    confidence: z.number().min(0).max(1).nullable(),
    reviewStatus: FactReviewStatus,
  })
  .superRefine((value, context) => {
    if ((value.extractionMethod === 'model') !== (value.confidence !== null)) {
      context.addIssue({ code: 'custom', path: ['confidence'], message: 'confidence is stated exactly for model extraction' });
    }
    if (value.locator !== EVIDENCE_FIELD_SOURCES[value.field].pointer) {
      context.addIssue({ code: 'custom', path: ['locator'], message: `locator for ${value.field} must be ${EVIDENCE_FIELD_SOURCES[value.field].pointer}` });
    }
  });
export type EvidenceFact = z.infer<typeof EvidenceFact>;
