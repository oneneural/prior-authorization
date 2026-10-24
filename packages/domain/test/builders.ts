import {
  type AssessmentResult,
  type Case,
  type Document,
  type EncounterBody,
  type EvidenceField,
  type Finding,
  type FindingStatus,
  type OrderBody,
  type OrderReceiptBody,
  type PolicyPack,
  type ResponsibleRole,
  type RuleId,
  type SourceDocumentBody,
  type StateEffect,
  type SupplierStatusBody,
  type SupportingNoteBody,
} from '@pa/contracts';

import { assess, type AssessmentOutcome } from '../src/assess.js';
import { type SourceInput } from '../src/documents.js';
import { webCryptoSha256 } from '../src/hash.js';

// In-memory synthetic inputs for unit tests. Domain tests never read fixture,
// oracle or policy pack files: the pack below is a test pack built in code
// whose outcome table mirrors the reviewed lab pack (docs/policy-slice.md).

export const SUBJECT_ID = 'SYN-BEN-T01';
export const SUBJECT_NAME = 'Riley Testcase';
export const ASSESSMENT_DATE = '2026-10-18';
export const PACK_ID = 'test-pack-k0823-v1';

const encoder = new TextEncoder();
export const bytesOf = (value: unknown) => encoder.encode(`${JSON.stringify(value, null, 2)}\n`);

export function supportedCase(overrides: Partial<Case> = {}): Case {
  const base: Case = {
    schemaVersion: 'pa.case.v1',
    caseId: 'case-t01',
    revision: 1,
    synthetic: true,
    subjectId: SUBJECT_ID,
    subjectName: SUBJECT_NAME,
    assessmentDate: ASSESSMENT_DATE,
    payerType: 'medicare_ffs',
    payerPrimary: true,
    beneficiaryState: 'CA',
    jurisdiction: 'noridian_jd',
    itemCode: 'K0823',
    requestKind: 'initial',
    urgency: 'standard',
    accessories: [],
    alreadyDelivered: false,
    lcmpIncorporated: false,
    supplierId: 'SYN-SUP-0001',
    supplierStatus: {
      schemaVersion: 'pa.supplier-status.v1',
      status: 'non_exempt',
      established: true,
      newEnrollment: false,
      ownershipChange: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
      evidenceId: 'supplier-status',
    },
    supplierStatusEvidenceId: 'supplier-status',
    policyPackId: PACK_ID,
    state: 'intake',
  };
  return { ...base, ...overrides };
}

export function orderBody(overrides: Partial<OrderBody> = {}): OrderBody {
  return {
    schemaVersion: 'pa.source.order.v1',
    documentKind: 'order',
    synthetic: true,
    status: 'final',
    beneficiary: { name: SUBJECT_NAME, identifier: SUBJECT_ID },
    orderDate: '2026-09-02',
    orderTime: null,
    item: { description: 'Power wheelchair, standard base (synthetic test)', code: 'K0823', quantity: 1 },
    treatingPractitioner: { name: 'Casey Example, MD (synthetic)', identifier: 'SYN-PRAC-0001' },
    signature: { signerName: 'Casey Example, MD (synthetic)', signedDate: '2026-09-02' },
    ...overrides,
  };
}

export function encounterBody(overrides: Partial<EncounterBody> = {}): EncounterBody {
  return {
    schemaVersion: 'pa.source.encounter.v1',
    documentKind: 'encounter',
    synthetic: true,
    status: 'final',
    beneficiary: { name: SUBJECT_NAME, identifier: SUBJECT_ID },
    encounterDate: '2026-08-20',
    completionTime: null,
    practitioner: { name: 'Casey Example, MD (synthetic)', identifier: 'SYN-PRAC-0001' },
    lcmpReport: { incorporated: false, evaluationDate: null },
    clinical: {
      diagnosisStatement: 'Synthetic test text: diagnosis statement.',
      mobilityLimitation: 'Synthetic test text: mobility limitation.',
      lowerLevelDevices: null,
      homeAccessibility: null,
      abilityToOperate: 'Synthetic test text: ability to operate.',
    },
    narrative: 'SYNTHETIC TEST DOCUMENT.',
    ...overrides,
  };
}

export function receiptBody(overrides: Partial<OrderReceiptBody> = {}): OrderReceiptBody {
  return {
    schemaVersion: 'pa.source.order-receipt.v1',
    documentKind: 'order_receipt',
    synthetic: true,
    beneficiary: { name: SUBJECT_NAME, identifier: SUBJECT_ID },
    orderReference: { documentId: 'order', version: 1 },
    receivedAt: '2026-09-03T17:05:00Z',
    recordedByRole: 'supplier intake coordinator (fictional)',
    ...overrides,
  };
}

export function supplierBody(overrides: Partial<SupplierStatusBody> = {}): SupplierStatusBody {
  return {
    schemaVersion: 'pa.source.supplier-status.v1',
    documentKind: 'supplier_status',
    synthetic: true,
    supplierId: 'SYN-SUP-0001',
    status: 'non_exempt',
    established: true,
    newEnrollment: false,
    ownershipChange: false,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    ...overrides,
  };
}

export function noteBody(overrides: Partial<SupportingNoteBody> = {}): SupportingNoteBody {
  return {
    schemaVersion: 'pa.source.supporting-note.v1',
    documentKind: 'supporting_note',
    synthetic: true,
    beneficiary: { name: SUBJECT_NAME, identifier: SUBJECT_ID },
    authoredDate: '2026-09-01',
    title: 'Supplier worksheet (synthetic)',
    text: 'Synthetic test text: ATP evaluation, specialty evaluation, home assessment and proof of delivery are not on file.',
    ...overrides,
  };
}

export interface SourceOptions {
  /** Bytes to supply instead of the body's; the content hash still covers the body. */
  bytes?: Uint8Array | null;
  meta?: Partial<Document>;
}

/** A document version whose `contentHash` is the SHA-256 of the body's bytes. */
export async function source(documentId: string, body: SourceDocumentBody | Uint8Array, options: SourceOptions = {}): Promise<SourceInput> {
  const raw = body instanceof Uint8Array ? body : bytesOf(body);
  const kind = body instanceof Uint8Array ? 'supporting_note' : body.documentKind;
  const meta: Document = {
    schemaVersion: 'pa.document.v1',
    documentId,
    version: 1,
    subjectId: kind === 'supplier_status' ? null : SUBJECT_ID,
    kind,
    contentHash: await webCryptoSha256(raw),
    mimeType: 'application/json',
    sourceSystem: kind === 'supplier_status' ? 'supplier_compliance' : 'practitioner_record',
    receivedAt: '2026-10-17T15:00:00Z',
    authoredAt: null,
    supersedes: null,
    syntheticProvenance: { origin: 'authored_synthetic', statement: 'Synthetic unit test document.' },
    accessStatus: 'available',
    ...options.meta,
  };
  if (meta.accessStatus === 'restricted') {
    return { meta: { ...meta, contentHash: null }, bytes: null };
  }
  return { meta, bytes: options.bytes === undefined ? raw : options.bytes };
}

/** The complete supported packet: order, encounter, receipt and supplier status. */
export async function supportedDocuments(): Promise<SourceInput[]> {
  return [
    await source('order', orderBody()),
    await source('encounter', encounterBody()),
    await source('receipt', receiptBody()),
    await source('supplier-status', supplierBody()),
  ];
}

const STAFF: ResponsibleRole = 'administrative_reviewer';
const COORDINATOR: ResponsibleRole = 'authorization_coordinator';

const outcome = (status: FindingStatus, stateEffect: StateEffect, responsibleRole: ResponsibleRole) => ({
  status,
  condition: `Test pack condition for ${status}.`,
  responsibleRole,
  stateEffect,
});

/** Outcome tables as in the reviewed lab pack: same statuses, order, roles and state effects. */
const REVIEW_THEN_INFORMATION = [
  outcome('conflict', 'needs_human_review', STAFF),
  outcome('manual_review', 'needs_human_review', STAFF),
  outcome('restricted', 'needs_information', COORDINATOR),
  outcome('unreadable', 'needs_information', COORDINATOR),
  outcome('missing', 'needs_information', COORDINATOR),
  outcome('pass', 'none', STAFF),
];

const RULES: Record<RuleId, { evidenceFields: EvidenceField[]; outcomes: ReturnType<typeof outcome>[] }> = {
  R01: {
    evidenceFields: ['supplier.id', 'supplier.status', 'supplier.established', 'supplier.new_enrollment', 'supplier.ownership_change', 'supplier.effective_from', 'supplier.effective_to', 'order.item_code'],
    outcomes: [
      outcome('conflict', 'scope_hold', COORDINATOR),
      outcome('restricted', 'scope_hold', COORDINATOR),
      outcome('unreadable', 'scope_hold', COORDINATOR),
      outcome('missing', 'scope_hold', COORDINATOR),
      outcome('pass', 'none', STAFF),
    ],
  },
  R02: {
    evidenceFields: ['order.beneficiary_name', 'order.beneficiary_identifier', 'encounter.beneficiary_name', 'encounter.beneficiary_identifier', 'receipt.beneficiary_name', 'receipt.beneficiary_identifier', 'note.beneficiary_name', 'note.beneficiary_identifier'],
    outcomes: [outcome('conflict', 'needs_human_review', STAFF), outcome('pass', 'none', STAFF)],
  },
  R03: {
    evidenceFields: ['order.beneficiary_name', 'order.beneficiary_identifier', 'order.date', 'order.item_description', 'order.quantity', 'order.practitioner_name', 'order.practitioner_identifier', 'order.signature_signer_name', 'order.signature_date'],
    outcomes: REVIEW_THEN_INFORMATION,
  },
  R04: {
    evidenceFields: ['encounter.status', 'encounter.date', 'encounter.completion_timestamp', 'encounter.practitioner_identifier', 'order.status', 'order.date', 'order.timestamp', 'order.practitioner_identifier'],
    outcomes: REVIEW_THEN_INFORMATION,
  },
  R05: {
    evidenceFields: ['receipt.order_document_id', 'receipt.order_document_version', 'receipt.received_at', 'order.date', 'order.timestamp'],
    outcomes: REVIEW_THEN_INFORMATION,
  },
  R06: {
    evidenceFields: ['clinical.diagnosis_statement', 'clinical.mobility_limitation', 'clinical.lower_level_devices', 'clinical.home_accessibility', 'clinical.ability_to_operate'],
    outcomes: [outcome('manual_review', 'none', 'qualified_clinical_reviewer')],
  },
  R07: {
    evidenceFields: ['encounter.lcmp_report_incorporated', 'encounter.lcmp_evaluation_date'],
    outcomes: [outcome('manual_review', 'needs_human_review', STAFF), outcome('pass', 'none', STAFF)],
  },
  R08: {
    evidenceFields: [],
    outcomes: [outcome('conflict', 'scope_hold', STAFF), outcome('missing', 'scope_hold', STAFF), outcome('pass', 'none', STAFF)],
  },
  R09: {
    evidenceFields: [],
    outcomes: [
      outcome('conflict', 'needs_human_review', STAFF),
      outcome('restricted', 'needs_information', COORDINATOR),
      outcome('unreadable', 'needs_information', COORDINATOR),
      outcome('pass', 'none', STAFF),
    ],
  },
  R10: { evidenceFields: [], outcomes: [outcome('not_applicable', 'none', STAFF)] },
};

export function testPack(overrides: Partial<PolicyPack> = {}): PolicyPack {
  return {
    schemaVersion: 'pa.policy-pack.v1',
    packId: PACK_ID,
    version: 1,
    title: 'Synthetic unit test pack',
    reviewedAsOf: ASSESSMENT_DATE,
    supportedAssessmentDates: [ASSESSMENT_DATE],
    scope: {
      payerType: 'medicare_ffs',
      payerPrimary: true,
      beneficiaryStates: ['CA'],
      jurisdictions: ['noridian_jd'],
      itemCodes: ['K0823'],
      requestKinds: ['initial'],
      urgencies: ['standard'],
      accessoriesPermitted: false,
      alreadyDeliveredPermitted: false,
      supplier: { statuses: ['non_exempt'], established: true, newEnrollment: false, ownershipChange: false },
      documentMimeTypes: ['application/json'],
      lcmpIncorporation: 'manual_review_branch',
    },
    rules: Object.entries(RULES).map(([ruleId, rule]) => ({
      ruleId: ruleId as RuleId,
      title: `Test rule ${ruleId}`,
      requirement: `Test requirement for ${ruleId}.`,
      applicability: { stage: 'initial_request_packet', itemCodes: ['K0823'], requestKinds: ['initial'], condition: 'Every test case.' },
      severity: ruleId === 'R06' || ruleId === 'R10' ? 'non_blocking' : 'blocking',
      evidenceFields: rule.evidenceFields,
      basis: 'lab',
      basisNote: 'Synthetic unit test rule.',
      sourceSections: [],
      outcomes: rule.outcomes,
    })),
    sourceRefs: [
      {
        sourceRefId: 'S08',
        title: 'Test source',
        publisher: 'Test publisher',
        url: 'https://example.org/test-source',
        retrievedOn: '2026-10-18',
        effectiveOn: null,
        updatedOn: null,
        version: null,
        usedFor: 'Unit tests.',
        limitation: 'Synthetic.',
      },
    ],
    labConventions: [],
    limitations: ['Synthetic unit test pack; not the reviewed lab pack.'],
    ...overrides,
  };
}

export interface RunOptions {
  pack?: PolicyPack | Uint8Array;
  assessmentDate?: string;
}

export async function outcomeOf(caseRecord: Case, documents: readonly SourceInput[], options: RunOptions = {}): Promise<AssessmentOutcome> {
  const pack = options.pack ?? testPack();
  return assess({
    caseRecord,
    documents,
    policyPackBytes: pack instanceof Uint8Array ? pack : bytesOf(pack),
    assessmentDate: options.assessmentDate ?? caseRecord.assessmentDate,
  });
}

/** Assesses and requires a result rather than a schema rejection. */
export async function run(caseRecord: Case, documents: readonly SourceInput[], options: RunOptions = {}): Promise<AssessmentResult> {
  const outcome = await outcomeOf(caseRecord, documents, options);
  if (outcome.outcome !== 'assessed') {
    throw new Error(`rejected: ${outcome.issues.join('; ')}`);
  }
  return outcome.result;
}

export function findingOf(result: AssessmentResult, ruleId: RuleId): Finding {
  const finding = result.findings.find((candidate) => candidate.ruleId === ruleId);
  if (finding === undefined) {
    throw new Error(`no ${ruleId} finding`);
  }
  return finding;
}

export const statusOf = (result: AssessmentResult, ruleId: RuleId) => findingOf(result, ruleId).status;

/** A finding's citations as `documentId@vN/locator`. */
export function citationsOf(result: AssessmentResult, ruleId: RuleId): string[] {
  const facts = new Map(result.evidenceFacts.map((fact) => [fact.factId, fact]));
  return findingOf(result, ruleId).evidenceFactIds.map((factId) => {
    const fact = facts.get(factId);
    return fact === undefined ? `missing ${factId}` : `${fact.documentId}@v${fact.documentVersion}${fact.locator}`;
  });
}

export const refsOf = (result: AssessmentResult, ruleId: RuleId) => findingOf(result, ruleId).documentRefs.map((ref) => `${ref.documentId}@v${ref.version}`);

/** Replaces the document with this ID in a packet. */
export const replace = (documents: readonly SourceInput[], documentId: string, replacement: SourceInput) =>
  documents.map((document) => (document.meta.documentId === documentId ? replacement : document));

export const without = (documents: readonly SourceInput[], documentId: string) => documents.filter((document) => document.meta.documentId !== documentId);
