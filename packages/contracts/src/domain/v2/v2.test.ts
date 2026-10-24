import { describe, expect, it } from 'vitest';

import { Case, Document, EncounterBody, EvidenceFact, OrderBody, SourceDocumentBody, SupportingNoteBody } from '../index.js';
import {
  AssessmentOutcomeV3,
  AssessmentResultV3,
  CanonicalText,
  CaseV2,
  ConditionDeclaration,
  DocumentExact,
  EncounterBodyExact,
  EvidenceFactV2,
  ExactText,
  FindingCondition,
  FindingV3,
  InputRejection,
  IntakeCaseV2,
  LogicalInputPointer,
  OrderBodyExact,
  OrderReceiptBodyExact,
  PolicyRuleV2,
  REJECTION_CODES_BY_STAGE,
  REJECTION_REASON_SHAPES,
  RejectionCode,
  SourceDocumentBodyExact,
  SupportingNoteBodyExact,
} from './index.js';

const HASH = 'a'.repeat(64);

const validCaseV1 = {
  schemaVersion: 'pa.case.v1',
  caseId: 'case-1',
  revision: 1,
  synthetic: true,
  subjectId: 'SYN-BEN-1',
  subjectName: 'Test Person',
  assessmentDate: '2026-10-18',
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
  supplierId: 'SYN-SUP-1',
  supplierStatus: {
    schemaVersion: 'pa.supplier-status.v1',
    status: 'non_exempt',
    established: true,
    newEnrollment: false,
    ownershipChange: false,
    effectiveFrom: '2026-01-01',
    effectiveTo: '2026-12-31',
    evidenceId: 'doc-supplier',
  },
  supplierStatusEvidenceId: 'doc-supplier',
  policyPackId: 'lab-k0823-jd-20261018-v2',
  state: 'intake',
};
const validCase = { ...validCaseV1, schemaVersion: 'pa.case.v2' };

const validDocument = {
  schemaVersion: 'pa.document.v1',
  documentId: 'doc-order',
  version: 1,
  subjectId: 'SYN-BEN-1',
  kind: 'order',
  contentHash: HASH,
  mimeType: 'application/json',
  sourceSystem: 'practitioner_record',
  receivedAt: '2026-10-17T15:00:00Z',
  authoredAt: '2026-09-02',
  supersedes: null,
  syntheticProvenance: { origin: 'authored_synthetic', statement: 'Synthetic test document.' },
  accessStatus: 'available',
};

const validOrder = {
  schemaVersion: 'pa.source.order.v1',
  documentKind: 'order',
  synthetic: true,
  status: 'final',
  beneficiary: { name: 'Test Person', identifier: 'SYN-BEN-1' },
  orderDate: '2026-09-02',
  orderTime: null,
  item: { description: 'Power wheelchair base', code: 'K0823', quantity: 1 },
  treatingPractitioner: { name: 'Dr Example', identifier: 'SYN-PRAC-1' },
  signature: { signerName: 'Dr Example', signedDate: '2026-09-02' },
};

const validEncounter = {
  schemaVersion: 'pa.source.encounter.v1',
  documentKind: 'encounter',
  synthetic: true,
  status: 'final',
  beneficiary: { name: 'Test Person', identifier: 'SYN-BEN-1' },
  encounterDate: '2026-09-01',
  completionTime: null,
  practitioner: { name: 'Dr Example', identifier: 'SYN-PRAC-1' },
  lcmpReport: { incorporated: false, evaluationDate: null },
  clinical: { diagnosisStatement: null, mobilityLimitation: null, lowerLevelDevices: null, homeAccessibility: null, abilityToOperate: null },
  narrative: 'Synthetic narrative.',
};

const validNote = {
  schemaVersion: 'pa.source.supporting-note.v1',
  documentKind: 'supporting_note',
  synthetic: true,
  beneficiary: { name: 'Test Person', identifier: 'SYN-BEN-1' },
  authoredDate: '2026-09-03',
  title: 'Note',
  text: 'Synthetic note.',
};

const validReceipt = {
  schemaVersion: 'pa.source.order-receipt.v1',
  documentKind: 'order_receipt',
  synthetic: true,
  beneficiary: { name: 'Test Person', identifier: 'SYN-BEN-1' },
  orderReference: { documentId: 'doc-order', version: 1 },
  receivedAt: '2026-09-03T18:00:00Z',
  recordedByRole: 'supplier intake',
};

const ref = (documentId: string, version = 1) => ({ documentId, version });

describe('non-transforming text (D1)', () => {
  it('returns text exactly, including surrounding whitespace', () => {
    expect(ExactText.parse('  padded  ')).toBe('  padded  ');
    expect(ExactText.parse('a')).toBe('a');
  });

  it('rejects empty and whitespace-only text exactly where the legacy trim did', () => {
    for (const blank of ['', ' ', '\t\n', ' ', ' ', '﻿']) {
      expect(ExactText.safeParse(blank).success, JSON.stringify(blank)).toBe(false);
    }
  });

  it('accepts canonical text only without surrounding whitespace', () => {
    expect(CanonicalText.parse('Test Person')).toBe('Test Person');
    expect(CanonicalText.safeParse(' Test Person').success).toBe(false);
    expect(CanonicalText.safeParse('Test Person\n').success).toBe(false);
    expect(CanonicalText.safeParse('').success).toBe(false);
  });

  it('never quotes the rejected value in an issue', () => {
    const result = CanonicalText.safeParse('  Secret Name  ');
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).not.toMatch(/Secret Name/);
  });
});

describe('pa.case.v2', () => {
  it('accepts a canonical case and returns it unchanged', () => {
    expect(CaseV2.parse(validCase)).toEqual(validCase);
    expect(IntakeCaseV2.parse(validCase)).toEqual(validCase);
  });

  it('rejects a subject name with surrounding whitespace that v1 silently trimmed', () => {
    expect(Case.parse({ ...validCaseV1, subjectName: ' Test Person ' }).subjectName).toBe('Test Person');
    const result = CaseV2.safeParse({ ...validCase, subjectName: ' Test Person ' });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['subjectName']]);
    expect(JSON.stringify(result.error?.issues)).not.toMatch(/Test Person/);
  });

  it('keeps the v1 invariants and does not accept the v1 literal', () => {
    expect(CaseV2.safeParse(validCaseV1).success).toBe(false);
    expect(CaseV2.safeParse({ ...validCase, supplierStatusEvidenceId: 'other' }).success).toBe(false);
    expect(IntakeCaseV2.safeParse({ ...validCase, state: 'ready_for_review' }).success).toBe(false);
    expect(CaseV2.safeParse({ ...validCase, extra: true }).success).toBe(false);
  });
});

describe('exact source and metadata parsers (D1)', () => {
  it('accept the same v1 literals and return padded text unchanged', () => {
    const padded = { ...validOrder, beneficiary: { name: ' Test Person ', identifier: 'SYN-BEN-1' } };
    expect(OrderBody.parse(padded).beneficiary.name).toBe('Test Person');
    expect(OrderBodyExact.parse(padded).beneficiary.name).toBe(' Test Person ');
    const document = { ...validDocument, syntheticProvenance: { origin: 'authored_synthetic', statement: ' Synthetic. ' } };
    expect(Document.parse(document).syntheticProvenance.statement).toBe('Synthetic.');
    expect(DocumentExact.parse(document).syntheticProvenance.statement).toBe(' Synthetic. ');
  });

  it('keep accepting blank text in fields that were unrestricted in v1', () => {
    for (const blank of ['', '   ']) {
      expect(EncounterBody.safeParse({ ...validEncounter, narrative: blank }).success).toBe(true);
      expect(EncounterBodyExact.parse({ ...validEncounter, narrative: blank }).narrative).toBe(blank);
      expect(SupportingNoteBody.safeParse({ ...validNote, text: blank }).success).toBe(true);
      expect(SupportingNoteBodyExact.parse({ ...validNote, text: blank }).text).toBe(blank);
    }
  });

  it('keep rejecting blank text in fields that required nonblank text in v1', () => {
    const cases: [string, unknown, unknown][] = [
      ['order beneficiary name', { ...validOrder, beneficiary: { name: '  ', identifier: null } }, OrderBodyExact],
      ['encounter diagnosis', { ...validEncounter, clinical: { ...validEncounter.clinical, diagnosisStatement: ' ' } }, EncounterBodyExact],
      ['receipt role', { ...validReceipt, recordedByRole: '' }, OrderReceiptBodyExact],
      ['note title', { ...validNote, title: '\t' }, SupportingNoteBodyExact],
    ];
    for (const [label, input, schema] of cases) {
      expect((schema as typeof OrderBodyExact).safeParse(input).success, label).toBe(false);
    }
    expect(DocumentExact.safeParse({ ...validDocument, syntheticProvenance: { origin: 'authored_synthetic', statement: ' ' } }).success).toBe(false);
  });

  it('accept exactly the inputs the legacy parsers accept', () => {
    const supplierStatusBody = {
      schemaVersion: 'pa.source.supplier-status.v1',
      documentKind: 'supplier_status',
      synthetic: true,
      supplierId: 'SYN-SUP-1',
      status: 'non_exempt',
      established: true,
      newEnrollment: false,
      ownershipChange: false,
      effectiveFrom: '2026-01-01',
      effectiveTo: '2026-12-31',
    };
    const inputs = [
      validOrder,
      validEncounter,
      validNote,
      validReceipt,
      supplierStatusBody,
      { ...supplierStatusBody, status: 'unknown', established: null },
      { ...supplierStatusBody, supplierId: ' SYN-SUP-1' },
      { ...validReceipt, recordedByRole: ' supplier intake ' },
      { ...validReceipt, recordedByRole: '  ' },
      { ...validOrder, signature: { signerName: ' ', signedDate: '2026-09-02' } },
      { ...validEncounter, clinical: { ...validEncounter.clinical, mobilityLimitation: ' limited ' } },
      { ...validEncounter, narrative: '' },
      { ...validNote, text: ' ' },
      { ...validOrder, documentKind: 'encounter' },
      { ...validOrder, extra: 1 },
    ];
    for (const input of inputs) {
      expect(SourceDocumentBodyExact.safeParse(input).success, JSON.stringify(input).slice(0, 80)).toBe(SourceDocumentBody.safeParse(input).success);
    }
  });

  it('re-parse to an identical value', () => {
    for (const input of [validOrder, validEncounter, validNote, validReceipt]) {
      const once = SourceDocumentBodyExact.parse(input);
      expect(SourceDocumentBodyExact.parse(JSON.parse(JSON.stringify(once)))).toEqual(once);
      expect(once).toEqual(input);
    }
    expect(DocumentExact.parse(validDocument)).toEqual(validDocument);
  });

  it('keep the metadata invariants', () => {
    expect(DocumentExact.safeParse({ ...validDocument, accessStatus: 'restricted' }).success).toBe(false);
    expect(DocumentExact.safeParse({ ...validDocument, kind: 'supplier_status' }).success).toBe(false);
    expect(DocumentExact.safeParse({ ...validDocument, version: 2, supersedes: ref('doc-order', 2) }).success).toBe(false);
    expect(DocumentExact.safeParse({ ...validDocument, version: 2, supersedes: ref('doc-order', 1) }).success).toBe(true);
  });
});

describe('pa.evidence-fact.v2', () => {
  const fact = {
    schemaVersion: 'pa.evidence-fact.v2',
    factId: 'fact-1',
    field: 'order.beneficiary_name',
    value: ' Test Person ',
    documentId: 'doc-order',
    documentVersion: 1,
    locator: '/beneficiary/name',
    originalText: ' Test Person ',
    extractionMethod: 'deterministic',
    confidence: null,
    reviewStatus: 'proposed',
  };
  const quantity = { ...fact, field: 'order.quantity', locator: '/item/quantity', value: 1, originalText: '1.0' };

  it('keeps the exact source text that v1 trimmed', () => {
    expect(EvidenceFact.parse({ ...fact, schemaVersion: 'pa.evidence-fact.v1' }).originalText).toBe('Test Person');
    expect(EvidenceFactV2.parse(fact).originalText).toBe(' Test Person ');
  });

  it('keeps the JSON number token as written while the value stays numeric', () => {
    expect(EvidenceFactV2.parse(quantity)).toMatchObject({ value: 1, originalText: '1.0' });
    expect(EvidenceFactV2.parse({ ...quantity, originalText: '1e0' }).originalText).toBe('1e0');
  });

  it('rejects original text that is not the source text of the value', () => {
    expect(EvidenceFactV2.safeParse({ ...fact, originalText: 'Test Person' }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...quantity, originalText: '2' }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...quantity, originalText: ' 1' }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...quantity, originalText: '01' }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...fact, value: ' ', originalText: ' ' }).success).toBe(false);
  });

  it('keeps the v1 locator and confidence invariants', () => {
    expect(EvidenceFactV2.safeParse({ ...fact, locator: '/item/quantity' }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...fact, confidence: 0.9 }).success).toBe(false);
    expect(EvidenceFactV2.safeParse({ ...fact, extractionMethod: 'model', confidence: 0.9 }).success).toBe(true);
  });
});

const finding = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pa.finding.v3',
  findingId: 'finding-r03',
  ruleId: 'R03',
  status: 'missing',
  severity: 'blocking',
  evidenceFactIds: [],
  documentRefs: [],
  conditions: [{ conditionKey: 'R03.element_missing', field: 'element.signature', documentRefs: [ref('doc-order')] }],
  explanation: 'The order states no signature metadata.',
  responsibleRole: 'authorization_coordinator',
  caseRevision: 1,
  ...overrides,
});

describe('pa.finding.v3 conditions (D2)', () => {
  it('accepts a missing-element condition naming its order while the parent refs stay empty (C07)', () => {
    expect(FindingV3.parse(finding()).documentRefs).toEqual([]);
  });

  it('requires conditions exactly when the status is not pass', () => {
    expect(FindingV3.safeParse(finding({ conditions: [] })).success).toBe(false);
    expect(FindingV3.safeParse(finding({ status: 'pass' })).success).toBe(false);
    expect(FindingV3.safeParse(finding({ status: 'pass', conditions: [] })).success).toBe(true);
  });

  it('distinguishes conditions by field and documents, and rejects duplicates', () => {
    const signature = { conditionKey: 'R03.element_missing', field: 'element.signature', documentRefs: [ref('doc-order')] };
    const quantity = { ...signature, field: 'element.quantity' };
    const other = { ...signature, documentRefs: [ref('doc-order', 2)] };
    expect(FindingV3.safeParse(finding({ conditions: [quantity, signature, other] })).success).toBe(true);
    expect(FindingV3.safeParse(finding({ conditions: [signature, signature] })).success).toBe(false);
  });

  it('serializes conditions and refs in canonical order', () => {
    const signature = { conditionKey: 'R03.element_missing', field: 'element.signature', documentRefs: [ref('doc-order')] };
    const quantity = { ...signature, field: 'element.quantity' };
    expect(FindingV3.safeParse(finding({ conditions: [signature, quantity] })).success).toBe(false);
    expect(FindingCondition.safeParse({ conditionKey: 'R03.orders_disagree', field: 'order.date', documentRefs: [ref('b'), ref('a')] }).success).toBe(false);
    expect(FindingCondition.safeParse({ conditionKey: 'R03.orders_disagree', field: 'order.date', documentRefs: [ref('a'), ref('a')] }).success).toBe(false);
    expect(FindingCondition.safeParse({ conditionKey: 'R03.orders_disagree', field: 'order.date', documentRefs: [ref('a', 1), ref('a', 2)] }).success).toBe(true);
  });

  it('orders conditions sharing key and field by their references element by element', () => {
    const disagree = (...refs: { documentId: string; version: number }[]) => ({ conditionKey: 'R03.orders_disagree', field: 'order.date', documentRefs: refs });
    const ordered = [disagree(ref('ord', 1), ref('ord', 9)), disagree(ref('ord', 1), ref('ord', 10))];
    expect(FindingV3.safeParse(finding({ status: 'conflict', conditions: ordered })).success).toBe(true);
    expect(FindingV3.safeParse(finding({ status: 'conflict', conditions: [...ordered].reverse() })).success).toBe(false);
    const prefixed = [disagree(ref('ord-1'), ref('x')), disagree(ref('ord-10'), ref('x'))];
    expect(FindingV3.safeParse(finding({ status: 'conflict', conditions: prefixed })).success).toBe(true);
    const shorter = [disagree(ref('a'), ref('b')), disagree(ref('a'), ref('b'), ref('c'))];
    expect(FindingV3.safeParse(finding({ status: 'conflict', conditions: shorter })).success).toBe(true);
    expect(FindingV3.safeParse(finding({ status: 'conflict', conditions: [...shorter].reverse() })).success).toBe(false);
  });

  it('rejects a condition of another rule and a malformed key', () => {
    expect(FindingV3.safeParse(finding({ conditions: [{ conditionKey: 'R04.no_usable_order', field: null, documentRefs: [] }] })).success).toBe(false);
    expect(FindingCondition.safeParse({ conditionKey: 'R11.thing', field: null, documentRefs: [] }).success).toBe(false);
    expect(FindingCondition.safeParse({ conditionKey: 'R03.Bad-Key', field: null, documentRefs: [] }).success).toBe(false);
  });
});

describe('condition declarations', () => {
  const declaration = {
    conditionKey: 'R03.element_missing',
    qualifier: 'order_element',
    fields: ['element.signature'],
    documentArity: 'one',
    documentKinds: ['order'],
    statement: 'A required element is absent.',
  };

  it('accepts a consistent declaration', () => {
    expect(ConditionDeclaration.safeParse(declaration).success).toBe(true);
  });

  it('rejects a field outside the qualifier vocabulary and inconsistent arity', () => {
    expect(ConditionDeclaration.safeParse({ ...declaration, fields: ['order.date'] }).success).toBe(false);
    expect(ConditionDeclaration.safeParse({ ...declaration, qualifier: 'none' }).success).toBe(false);
    expect(ConditionDeclaration.safeParse({ ...declaration, documentArity: 'none' }).success).toBe(false);
    expect(ConditionDeclaration.safeParse({ ...declaration, statement: ' padded' }).success).toBe(false);
  });

  it('rejects a rule whose outcome owns another rule\'s condition or whose pass owns one', () => {
    const rule = {
      ruleId: 'R04',
      title: 'Title',
      requirement: 'Requirement.',
      applicability: { stage: 'initial_request_packet', itemCodes: ['K0823'], requestKinds: ['initial'], condition: 'Always.' },
      severity: 'blocking',
      evidenceFields: [],
      basis: 'lab',
      basisNote: 'Note.',
      sourceSections: [],
      outcomes: [
        { status: 'missing', condition: 'Missing.', responsibleRole: 'authorization_coordinator', stateEffect: 'needs_information', conditions: [declaration] },
        { status: 'pass', condition: 'Pass.', responsibleRole: 'administrative_reviewer', stateEffect: 'none', conditions: [] },
      ],
    };
    expect(PolicyRuleV2.safeParse(rule).success).toBe(false);
    expect(PolicyRuleV2.safeParse({ ...rule, ruleId: 'R03' }).success).toBe(true);
    const passOwns = { ...rule, ruleId: 'R03', outcomes: [rule.outcomes[0], { ...rule.outcomes[1], conditions: [declaration] }] };
    expect(PolicyRuleV2.safeParse(passOwns).success).toBe(false);
  });
});

const result = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 'pa.assessment-result.v3',
  caseId: 'case-1',
  caseRevision: 1,
  policyPackId: 'lab-k0823-jd-20261018-v2',
  policyPackSha256: HASH,
  state: 'needs_human_review',
  findings: [
    finding({
      findingId: 'finding-r02',
      ruleId: 'R02',
      status: 'conflict',
      documentRefs: [ref('doc-order', 2)],
      conditions: [{ conditionKey: 'R02.document_quarantined', field: 'binding.stated_name', documentRefs: [ref('doc-order', 2)] }],
      responsibleRole: 'administrative_reviewer',
    }),
    finding(),
  ],
  quarantinedDocuments: [ref('doc-order', 2)],
  supersededDocuments: [],
  evidenceFacts: [],
  ...overrides,
});

describe('pa.assessment-result.v3 (D3, D5)', () => {
  it('quarantines by exact version, so another version of the ID stays citable', () => {
    expect(AssessmentResultV3.safeParse(result()).success).toBe(true);
  });

  it('lets only R02 name a quarantined version', () => {
    const r03 = finding({ conditions: [{ conditionKey: 'R03.element_missing', field: 'element.signature', documentRefs: [ref('doc-order', 2)] }] });
    expect(AssessmentResultV3.safeParse(result({ findings: [result().findings[0], r03] })).success).toBe(false);
  });

  it('requires R02 to name exactly the quarantined versions', () => {
    expect(AssessmentResultV3.safeParse(result({ quarantinedDocuments: [ref('doc-order', 2), ref('doc-note')] })).success).toBe(false);
    expect(AssessmentResultV3.safeParse(result({ quarantinedDocuments: [ref('doc-order', 2), ref('doc-order', 2)] })).success).toBe(false);
  });

  it('lists superseded versions by reference and keeps them out of later rules and facts', () => {
    const supersededDocuments = [ref('doc-order')];
    expect(AssessmentResultV3.safeParse(result({ supersededDocuments })).success).toBe(false);
    const r03 = finding({ conditions: [{ conditionKey: 'R03.element_missing', field: 'element.signature', documentRefs: [ref('doc-order', 3)] }] });
    expect(AssessmentResultV3.safeParse(result({ supersededDocuments, findings: [result().findings[0], r03] })).success).toBe(true);
    expect(AssessmentResultV3.safeParse(result({ supersededDocuments: [ref('doc-order'), ref('doc-order')], findings: [result().findings[0], r03] })).success).toBe(false);
    const fact = {
      schemaVersion: 'pa.evidence-fact.v2',
      factId: 'fact-1',
      field: 'order.quantity',
      value: 1,
      documentId: 'doc-order',
      documentVersion: 1,
      locator: '/item/quantity',
      originalText: '1',
      extractionMethod: 'deterministic',
      confidence: null,
      reviewStatus: 'proposed',
    };
    expect(AssessmentResultV3.safeParse(result({ supersededDocuments, findings: [result().findings[0], r03], evidenceFacts: [fact] })).success).toBe(false);
    expect(AssessmentResultV3.safeParse(result({ findings: [result().findings[0], r03], evidenceFacts: [fact] })).success).toBe(true);
  });

  it('rejects two findings for one rule', () => {
    expect(AssessmentResultV3.safeParse(result({ findings: [...result().findings, finding({ findingId: 'other' })] })).success).toBe(false);
  });
});

describe('explicit input rejection (D6)', () => {
  const rejection = (stage: string, reasons: unknown[]) => ({ schemaVersion: 'pa.input-rejection.v1', stage, reasons });

  it('freezes the reason grammar by stage', () => {
    expect(REJECTION_CODES_BY_STAGE).toEqual({
      input_boundary: ['document_count_exceeded', 'path_outside_root', 'document_size_exceeded'],
      schema: ['case_invalid', 'document_metadata_invalid', 'policy_pack_invalid', 'policy_pack_incomplete', 'assessment_date_invalid', 'assessment_date_mismatch'],
      snapshot_integrity: [
        'duplicate_document_version',
        'restricted_document_has_bytes',
        'document_bytes_missing',
        'supersession_cross_document',
        'supersession_cross_kind',
        'supersession_cross_subject',
        'supersession_cycle',
      ],
    });
    expect(RejectionCode.options).toHaveLength(16);
    expect(Object.keys(REJECTION_REASON_SHAPES).sort()).toEqual([...RejectionCode.options].sort());
  });

  it('accepts every code in its frozen shape', () => {
    const slot = 'f01-order.v1';
    for (const [code, shape] of Object.entries(REJECTION_REASON_SHAPES)) {
      const stage = Object.entries(REJECTION_CODES_BY_STAGE).find(([, codes]) => (codes as readonly string[]).includes(code))?.[0] ?? '';
      const documentRef = shape.documentRef === 'required' ? ref('doc-order', 2) : null;
      const path = shape.path === null ? null : shape.path.replace('<slot>', slot);
      expect(InputRejection.safeParse(rejection(stage, [{ code, documentRef, path }])).success, code).toBe(true);
    }
    const metadata = { code: 'document_metadata_invalid', path: '/documents/f01-order.v1/metadata' };
    expect(InputRejection.safeParse(rejection('schema', [{ ...metadata, documentRef: ref('f01-order') }])).success).toBe(true);
  });

  it('rejects a reason whose reference or path breaks its frozen shape', () => {
    const invalid: [string, unknown][] = [
      ['schema', { code: 'document_metadata_invalid', documentRef: null, path: '/documents/f01-order.v1/metadata/subjectId' }],
      ['schema', { code: 'case_invalid', documentRef: null, path: '/case/subjectName' }],
      ['schema', { code: 'case_invalid', documentRef: ref('doc-order'), path: '/case' }],
      ['snapshot_integrity', { code: 'supersession_cycle', documentRef: ref('doc-order', 2), path: null }],
      ['snapshot_integrity', { code: 'supersession_cycle', documentRef: null, path: '/documents/x.v2/metadata/supersedes' }],
      ['snapshot_integrity', { code: 'document_bytes_missing', documentRef: ref('doc-order'), path: '/documents/x.v1/metadata' }],
      ['input_boundary', { code: 'path_outside_root', documentRef: null, path: '/documents' }],
      ['input_boundary', { code: 'document_size_exceeded', documentRef: ref('doc-order'), path: '/documents/x.v1/payload' }],
      ['input_boundary', { code: 'document_count_exceeded', documentRef: null, path: '/documents/x.v1' }],
    ];
    for (const [stage, reason] of invalid) {
      expect(InputRejection.safeParse(rejection(stage, [reason])).success, JSON.stringify(reason)).toBe(false);
    }
  });

  it('accepts duplicate-version reasons that share a ref at distinct slot paths', () => {
    const duplicate = (slot: string) => ({ code: 'duplicate_document_version', documentRef: ref('ord'), path: `/documents/${slot}/metadata` });
    // `.` (U+002E) precedes `/` (U+002F), so the suffixed slot's path sorts first.
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [duplicate('ord.v1.dup1'), duplicate('ord.v1')])).success).toBe(true);
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [duplicate('ord.v1'), duplicate('ord.v1.dup1')])).success).toBe(false);
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [duplicate('ord.v1'), duplicate('ord.v1')])).success).toBe(false);
  });

  it('orders reasons element by element, with versions compared numerically', () => {
    const reason = (documentId: string, version: number) => ({ code: 'duplicate_document_version', documentRef: ref(documentId, version), path: `/documents/${documentId}.v${version}/metadata` });
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [reason('ord', 9), reason('ord', 10)])).success).toBe(true);
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [reason('ord', 10), reason('ord', 9)])).success).toBe(false);
    expect(InputRejection.safeParse(rejection('snapshot_integrity', [reason('ord-1', 1), reason('ord-10', 1)])).success).toBe(true);
    const nullRef = { code: 'document_metadata_invalid', documentRef: null, path: '/documents/b.v1/metadata' };
    const withRef = { code: 'document_metadata_invalid', documentRef: ref('a'), path: '/documents/a.v1/metadata' };
    expect(InputRejection.safeParse(rejection('schema', [nullRef, withRef])).success).toBe(true);
    expect(InputRejection.safeParse(rejection('schema', [withRef, nullRef])).success).toBe(false);
  });

  it('rejects a reason from another stage, an empty set and unsorted or duplicate reasons', () => {
    expect(InputRejection.safeParse(rejection('schema', [{ code: 'supersession_cycle', documentRef: null, path: null }])).success).toBe(false);
    expect(InputRejection.safeParse(rejection('schema', [])).success).toBe(false);
    const a = { code: 'case_invalid', documentRef: null, path: '/case' };
    const b = { code: 'policy_pack_invalid', documentRef: null, path: '/policyPack' };
    expect(InputRejection.safeParse(rejection('schema', [a, b])).success).toBe(true);
    expect(InputRejection.safeParse(rejection('schema', [b, a])).success).toBe(false);
    expect(InputRejection.safeParse(rejection('schema', [a, a])).success).toBe(false);
  });

  it('never accepts a host path as a pointer', () => {
    for (const path of ['/outside-root/fixtures/f01-order.v1.json', '../outside.json', 'documents/x', '/documents/../x', '/documents/x/body']) {
      expect(LogicalInputPointer.safeParse(path).success, path).toBe(false);
    }
    for (const path of ['/case', '/assessmentDate', '/policyPack/rules/0', '/documents/f01-order.v1/payload', '/documents/f01-order.v1/metadata/supersedes/version']) {
      expect(LogicalInputPointer.safeParse(path).success, path).toBe(true);
    }
  });

  it('discriminates an assessed result from a rejection with no partial result', () => {
    const rejected = { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'rejected', rejection: rejection('schema', [{ code: 'case_invalid', documentRef: null, path: '/case' }]) };
    expect(AssessmentOutcomeV3.safeParse(rejected).success).toBe(true);
    expect(AssessmentOutcomeV3.safeParse({ ...rejected, result: result() }).success).toBe(false);
    expect(AssessmentOutcomeV3.safeParse({ schemaVersion: 'pa.assessment-outcome.v3', outcome: 'assessed', result: result() }).success).toBe(true);
  });
});
