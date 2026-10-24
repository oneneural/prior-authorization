import {
  type CaseV2,
  type ConditionDeclaration,
  type DocumentExact,
  type FindingStatus,
  type PolicyPackV2,
  type PolicyRuleV2,
  type ResponsibleRole,
  type RuleId,
  type SourceDocumentBodyExact,
  type StateEffect,
} from '@pa/contracts';

import { webCryptoSha256 } from '../src/hash.js';
import { type AssessmentInputV2, type DocumentInputV2 } from '../src/v2/input.js';
import { bytesOf, encounterBody, noteBody, orderBody, receiptBody, SUBJECT_ID, SUBJECT_NAME, supplierBody } from './builders.js';

// In-memory synthetic version 2 inputs for unit tests. Like the version 1
// builders, they never read fixture, oracle or policy pack files: the pack
// below is a test pack built in code from its own table, which follows the
// reviewed condition vocabulary (docs/policy-slice.md) and also declares the
// unreachable `R09.locator_unresolved`.

export { bytesOf, encounterBody, noteBody, orderBody, receiptBody, SUBJECT_ID, SUBJECT_NAME, supplierBody };

export const ASSESSMENT_DATE = '2026-10-18';
export const PACK_ID = 'test-pack-k0823-v2';

export function caseV2(overrides: Partial<CaseV2> = {}): CaseV2 {
  return {
    schemaVersion: 'pa.case.v2',
    caseId: 'case-v2-t01',
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
    ...overrides,
  };
}

type Row = [conditionKey: string, qualifier: ConditionDeclaration['qualifier'], fields: string[], arity: ConditionDeclaration['documentArity'], kinds: string[]];
type OutcomeRow = [status: FindingStatus, effect: StateEffect, role: ResponsibleRole, conditions: Row[]];

const ANY = ['order', 'encounter', 'order_receipt', 'supplier_status', 'supporting_note'];
const BOUND = ['order', 'encounter', 'order_receipt', 'supporting_note'];
const SCOPE = ['payerType', 'payerPrimary', 'beneficiaryState', 'jurisdiction', 'itemCode', 'requestKind', 'urgency', 'accessories', 'alreadyDelivered'].map((field) => `case.${field}`);
const SUPPLIER_SCOPE = ['status', 'established', 'newEnrollment', 'ownershipChange'].map((field) => `case.supplierStatus.${field}`);
const SUPPLIER = ['status', 'established', 'new_enrollment', 'ownership_change', 'effective_from', 'effective_to'].map((field) => `supplier.${field}`);
const ORDER = ['beneficiary_name', 'beneficiary_identifier', 'date', 'item_description', 'quantity', 'practitioner_name', 'practitioner_identifier', 'signature_signer_name', 'signature_date'].map(
  (field) => `order.${field}`,
);
const ELEMENTS = ['beneficiary', 'order_date', 'item_description', 'quantity', 'practitioner', 'signature'].map((element) => `element.${element}`);
const BASES = ['metadata_subject', 'stated_identifier', 'stated_name'].map((basis) => `binding.${basis}`);
const AC = 'authorization_coordinator';
const AR = 'administrative_reviewer';
const none = (key: string): Row => [key, 'none', [], 'none', []];
const one = (key: string, ...kinds: string[]): Row => [key, 'none', [], 'one', kinds];
const two = (key: string, ...kinds: string[]): Row => [key, 'none', [], 'two', kinds];
const PASS: OutcomeRow = ['pass', 'none', AR, []];

/** The outcome table of the test pack, in precedence order per rule. */
export const TEST_OUTCOMES: Record<RuleId, OutcomeRow[]> = {
  R01: [
    [
      'conflict',
      'scope_hold',
      AC,
      [
        ['R01.scope_fact_unsupported', 'case_scope_field', [...SCOPE, ...SUPPLIER_SCOPE], 'none', []],
        none('R01.case_supplier_interval_excludes_date'),
        one('R01.supplier_id_disagrees', 'supplier_status'),
        ['R01.supplier_record_disagrees', 'evidence_field', SUPPLIER, 'one', ['supplier_status']],
        one('R01.supplier_record_interval_excludes_date', 'supplier_status'),
        one('R01.order_item_code_disagrees', 'order'),
      ],
    ],
    ['manual_review', 'scope_hold', AR, [one('R01.supplier_record_failed_provenance', 'supplier_status')]],
    ['restricted', 'scope_hold', AC, [one('R01.supplier_record_restricted', 'supplier_status')]],
    ['unreadable', 'scope_hold', AC, [one('R01.supplier_record_unreadable', 'supplier_status')]],
    [
      'missing',
      'scope_hold',
      AC,
      [
        ['R01.scope_fact_unknown', 'case_scope_field', [...SCOPE, 'case.lcmpIncorporated', 'case.supplierStatusEvidenceId', ...SUPPLIER_SCOPE, 'case.supplierStatus.effectiveFrom', 'case.supplierStatus.effectiveTo'], 'none', []],
        ['R01.supplier_record_value_unknown', 'evidence_field', SUPPLIER, 'one', ['supplier_status']],
        none('R01.supplier_record_not_supplied'),
      ],
    ],
    PASS,
  ],
  R02: [['conflict', 'needs_human_review', AR, [['R02.document_quarantined', 'binding_basis', BASES, 'one', BOUND]]], PASS],
  R03: [
    ['conflict', 'needs_human_review', AR, [['R03.orders_disagree', 'evidence_field', ORDER, 'two_or_more', ['order']]]],
    ['manual_review', 'needs_human_review', AR, [one('R03.order_failed_provenance', 'order')]],
    ['restricted', 'needs_information', AC, [one('R03.order_restricted', 'order')]],
    ['unreadable', 'needs_information', AC, [one('R03.order_unreadable', 'order')]],
    ['missing', 'needs_information', AC, [none('R03.no_usable_order'), ['R03.element_missing', 'order_element', ELEMENTS, 'one', ['order']]]],
    PASS,
  ],
  R04: [
    [
      'conflict',
      'needs_human_review',
      AR,
      [
        two('R04.practitioner_identifier_differs', 'encounter', 'order'),
        two('R04.order_before_encounter', 'encounter', 'order'),
        two('R04.order_after_bound', 'encounter', 'order'),
        ['R04.encounters_disagree', 'evidence_field', ['encounter.date'], 'two_or_more', ['encounter']],
        ['R04.orders_disagree', 'evidence_field', ['order.date'], 'two_or_more', ['order']],
      ],
    ],
    [
      'manual_review',
      'needs_human_review',
      AR,
      [
        two('R04.same_day_unsequenced', 'encounter', 'order'),
        two('R04.practitioner_identifier_absent', 'encounter', 'order'),
        none('R04.lcmp_stated_by_case'),
        one('R04.lcmp_stated_by_encounter', 'encounter'),
        one('R04.encounter_failed_provenance', 'encounter'),
        one('R04.order_failed_provenance', 'order'),
      ],
    ],
    ['restricted', 'needs_information', AC, [one('R04.encounter_restricted', 'encounter'), one('R04.order_restricted', 'order')]],
    ['unreadable', 'needs_information', AC, [one('R04.encounter_unreadable', 'encounter'), one('R04.order_unreadable', 'order')]],
    [
      'missing',
      'needs_information',
      AC,
      [
        none('R04.no_usable_encounter'),
        none('R04.no_usable_order'),
        one('R04.encounter_not_final', 'encounter'),
        one('R04.order_not_final', 'order'),
        ['R04.date_not_stated', 'evidence_field', ['encounter.date', 'order.date'], 'one', ['encounter', 'order']],
      ],
    ],
    PASS,
  ],
  R05: [
    ['conflict', 'needs_human_review', AR, [two('R05.receipt_before_order', 'order_receipt', 'order')]],
    ['manual_review', 'needs_human_review', AR, [two('R05.receipt_unsequenced', 'order_receipt', 'order'), one('R05.receipt_failed_provenance', 'order_receipt')]],
    ['restricted', 'needs_information', AC, [one('R05.receipt_restricted', 'order_receipt')]],
    ['unreadable', 'needs_information', AC, [one('R05.receipt_unreadable', 'order_receipt')]],
    ['missing', 'needs_information', AC, [none('R05.no_usable_receipt'), one('R05.order_receipt_missing', 'order'), none('R05.no_usable_order')]],
    PASS,
  ],
  R06: [['manual_review', 'none', 'qualified_clinical_reviewer', [none('R06.clinical_review')]]],
  R07: [['manual_review', 'needs_human_review', AR, [none('R07.lcmp_stated_by_case'), one('R07.lcmp_stated_by_encounter', 'encounter')]], PASS],
  R08: [
    ['conflict', 'scope_hold', AR, [none('R08.pack_id_differs'), none('R08.assessment_date_unsupported')]],
    ['missing', 'scope_hold', AR, [none('R08.pack_unreviewed'), none('R08.pack_unsourced')]],
    PASS,
  ],
  R09: [
    ['conflict', 'needs_human_review', AR, [one('R09.hash_mismatch', ...ANY), one('R09.kind_mismatch', ...ANY), one('R09.locator_unresolved', ...ANY)]],
    ['restricted', 'needs_information', AC, [one('R09.access_restricted', ...ANY)]],
    ['unreadable', 'needs_information', AC, [one('R09.access_unreadable', ...ANY), one('R09.mime_unsupported', ...ANY), one('R09.body_invalid', ...ANY)]],
    PASS,
  ],
  R10: [['not_applicable', 'none', AR, [none('R10.pure_assessment')]]],
};

function ruleOf(ruleId: RuleId, rows: OutcomeRow[]): PolicyRuleV2 {
  return {
    ruleId,
    title: `Test rule ${ruleId}`,
    requirement: `Synthetic test requirement for ${ruleId}.`,
    applicability: { stage: 'initial_request_packet', itemCodes: ['K0823'], requestKinds: ['initial'], condition: 'Every test case.' },
    severity: ruleId === 'R06' || ruleId === 'R10' ? 'non_blocking' : 'blocking',
    evidenceFields: [],
    basis: 'lab',
    basisNote: 'Synthetic test rule.',
    sourceSections: [],
    outcomes: rows.map(([status, stateEffect, responsibleRole, conditions]) => ({
      status,
      condition: `Synthetic ${status} outcome.`,
      responsibleRole,
      stateEffect,
      conditions: conditions.map(([conditionKey, qualifier, fields, documentArity, documentKinds]) => ({
        conditionKey,
        qualifier,
        fields,
        documentArity,
        documentKinds,
        statement: `Synthetic statement for ${conditionKey}.`,
      })) as ConditionDeclaration[],
    })),
  };
}

/** A complete test pack covering the evaluator inventory, plus `R09.locator_unresolved`. */
export function packV2(): PolicyPackV2 {
  return {
    schemaVersion: 'pa.policy-pack.v2',
    packId: PACK_ID,
    version: 2,
    title: 'Synthetic test pack',
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
    rules: (Object.entries(TEST_OUTCOMES) as [RuleId, OutcomeRow[]][]).map(([ruleId, rows]) => ruleOf(ruleId, rows)),
    sourceRefs: [],
    labConventions: [],
    limitations: ['Synthetic test pack.'],
  };
}

/** A copy of a pack with one rule edited in place. */
export function editRule(pack: PolicyPackV2, ruleId: RuleId, edit: (rule: PolicyRuleV2) => void): PolicyPackV2 {
  const copy = structuredClone(pack);
  const rule = copy.rules.find((candidate) => candidate.ruleId === ruleId);
  if (rule === undefined) {
    throw new Error(`no ${ruleId}`);
  }
  edit(rule);
  return copy;
}

/** A copy of a pack without one condition key. */
export const withoutKey = (pack: PolicyPackV2, conditionKey: string) =>
  editRule(pack, conditionKey.slice(0, 3) as RuleId, (rule) => {
    for (const outcome of rule.outcomes) {
      outcome.conditions = outcome.conditions.filter((condition) => condition.conditionKey !== conditionKey);
    }
  });

/** A copy of a pack without one outcome. */
export const withoutOutcome = (pack: PolicyPackV2, ruleId: RuleId, status: FindingStatus) =>
  editRule(pack, ruleId, (rule) => {
    rule.outcomes = rule.outcomes.filter((outcome) => outcome.status !== status);
  });

/** A copy of a pack without one rule. */
export function withoutRule(pack: PolicyPackV2, ruleId: RuleId): PolicyPackV2 {
  const copy = structuredClone(pack);
  copy.rules = copy.rules.filter((rule) => rule.ruleId !== ruleId);
  return copy;
}

export interface DocumentOptions {
  version?: number;
  meta?: Partial<DocumentExact>;
  /** Payload bytes to supply instead of the body's; `contentHash` still covers the body. */
  payload?: Uint8Array | null;
  /** Metadata bytes to supply instead of the built metadata. */
  metadataBytes?: Uint8Array;
}

/** One version whose `contentHash` is the SHA-256 of its body bytes. */
export async function documentV2(slot: string, documentId: string, body: SourceDocumentBodyExact | Uint8Array, options: DocumentOptions = {}): Promise<DocumentInputV2 & { meta: DocumentExact }> {
  const raw = body instanceof Uint8Array ? body : bytesOf(body);
  const kind = body instanceof Uint8Array ? 'supporting_note' : body.documentKind;
  const meta: DocumentExact = {
    schemaVersion: 'pa.document.v1',
    documentId,
    version: options.version ?? 1,
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
  const restricted = meta.accessStatus === 'restricted';
  const finalMeta = restricted ? { ...meta, contentHash: null } : meta;
  const payload = options.payload !== undefined ? options.payload : restricted ? null : raw;
  return { slot, meta: finalMeta, metadata: options.metadataBytes ?? bytesOf(finalMeta), payload };
}

/** The complete supported packet: order, encounter, receipt and supplier status. */
export async function supportedDocumentsV2() {
  return [
    await documentV2('order.v1', 'order', orderBody()),
    await documentV2('encounter.v1', 'encounter', encounterBody()),
    await documentV2('receipt.v1', 'receipt', receiptBody()),
    await documentV2('supplier-status.v1', 'supplier-status', supplierBody()),
  ];
}

export interface InputOptions {
  caseRecord?: unknown;
  caseBytes?: Uint8Array;
  pack?: unknown;
  packBytes?: Uint8Array;
  assessmentDate?: string;
}

export function inputV2(documents: readonly DocumentInputV2[], options: InputOptions = {}): AssessmentInputV2 {
  return {
    caseBytes: options.caseBytes ?? bytesOf(options.caseRecord ?? caseV2()),
    policyPackBytes: options.packBytes ?? bytesOf(options.pack ?? packV2()),
    assessmentDate: options.assessmentDate ?? ASSESSMENT_DATE,
    documents: documents.map(({ slot, metadata, payload }) => ({ slot, metadata, payload })),
  };
}

/** A deterministic nontrivial permutation: every third element first, then the rest, each in order. */
export function permute<T>(values: readonly T[]): T[] {
  return [...values.filter((_, index) => index % 3 === 2), ...values.filter((_, index) => index % 3 !== 2)];
}
