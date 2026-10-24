import { describe, expect, it } from 'vitest';
import { type z } from 'zod';

import * as domain from './index.js';
import {
  AccessStatus,
  AssessedState,
  AssessmentResult,
  Case,
  CaseState,
  CLINICAL_EVIDENCE_FIELDS,
  Document,
  EVIDENCE_FIELD_SOURCES,
  EvidenceFact,
  EvidenceField,
  Finding,
  FindingStatus,
  IntakeCase,
  IsoDate,
  JsonPointer,
  OrderBody,
  PolicyPack,
  PolicyRule,
  SourceDocumentBody,
  SupplierStatus,
  UtcTimestamp,
} from './index.js';

const HASH = 'a'.repeat(64);

const supplierStatus = {
  schemaVersion: 'pa.supplier-status.v1',
  status: 'non_exempt',
  established: true,
  newEnrollment: false,
  ownershipChange: false,
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
  evidenceId: 'doc-supplier',
};

const validCase = {
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
  supplierStatus,
  supplierStatusEvidenceId: 'doc-supplier',
  policyPackId: 'lab-pack-v1',
  state: 'intake',
};

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
  beneficiary: { name: 'Test Person', identifier: null },
  orderDate: '2026-09-02',
  orderTime: { timestamp: '2026-09-02T15:10:00-07:00', timeZone: 'America/Los_Angeles' },
  item: { description: 'Power wheelchair', code: 'K0823', quantity: 1 },
  treatingPractitioner: { name: null, identifier: 'SYN-PRAC-1' },
  signature: { signerName: 'Test Practitioner', signedDate: '2026-09-02' },
};

const validFact = {
  schemaVersion: 'pa.evidence-fact.v1',
  factId: 'fact-1',
  field: 'order.date',
  value: '2026-09-02',
  documentId: 'doc-order',
  documentVersion: 1,
  locator: '/orderDate',
  originalText: '2026-09-02',
  extractionMethod: 'deterministic',
  confidence: null,
  reviewStatus: 'accepted',
};

const validFinding = {
  schemaVersion: 'pa.finding.v2',
  findingId: 'finding-1',
  ruleId: 'R03',
  status: 'pass',
  severity: 'blocking',
  evidenceFactIds: ['fact-1'],
  documentRefs: [],
  explanation: 'The order states every required element.',
  responsibleRole: 'administrative_reviewer',
  caseRevision: 1,
};

const validResult = {
  schemaVersion: 'pa.assessment-result.v2',
  caseId: 'case-1',
  caseRevision: 1,
  policyPackId: 'lab-pack-v1',
  policyPackSha256: HASH,
  state: 'ready_for_review',
  findings: [validFinding],
  quarantinedDocumentIds: [],
  evidenceFacts: [validFact],
};

const validRule = {
  ruleId: 'R03',
  title: 'Existing order elements',
  requirement: 'The order states its required elements.',
  applicability: { stage: 'initial_request_packet', itemCodes: ['K0823'], requestKinds: ['initial'], condition: 'Every case.' },
  severity: 'blocking',
  evidenceFields: ['order.date'],
  basis: 'source',
  basisNote: 'Standard written order elements.',
  sourceSections: [{ sourceRefId: 'S09', section: 'Order elements' }],
  outcomes: [
    { status: 'missing', condition: 'An element is absent.', responsibleRole: 'authorization_coordinator', stateEffect: 'needs_information' },
    { status: 'pass', condition: 'Every element is present.', responsibleRole: 'administrative_reviewer', stateEffect: 'none' },
  ],
};

const validPack = {
  schemaVersion: 'pa.policy-pack.v1',
  packId: 'lab-pack-v1',
  version: 1,
  title: 'Test pack',
  reviewedAsOf: '2026-10-18',
  supportedAssessmentDates: ['2026-10-18'],
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
  rules: [validRule],
  sourceRefs: [
    {
      sourceRefId: 'S09',
      title: 'A source',
      publisher: 'A publisher',
      url: 'https://example.org/source',
      retrievedOn: '2026-10-18',
      effectiveOn: null,
      updatedOn: null,
      version: null,
      usedFor: 'R03',
      limitation: 'Summarized.',
    },
  ],
  labConventions: [{ conventionId: 'C01', ruleIds: ['R03'], statement: 'A lab convention.' }],
  limitations: ['Authored lab subset.'],
};

const records: [string, z.ZodType, Record<string, unknown>][] = [
  ['SupplierStatus', SupplierStatus, supplierStatus],
  ['Case', Case, validCase],
  ['Document', Document, validDocument],
  ['OrderBody', OrderBody, validOrder],
  ['EvidenceFact', EvidenceFact, validFact],
  ['Finding', Finding, validFinding],
  ['PolicyRule', PolicyRule, validRule],
  ['PolicyPack', PolicyPack, validPack],
  ['AssessmentResult', AssessmentResult, validResult],
];

const without = (value: Record<string, unknown>, key: string) => Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));

describe('domain records', () => {
  it.each(records)('%s accepts a valid example', (_name, schema, value) => {
    expect(schema.safeParse(value).error).toBeUndefined();
  });

  it.each(records)('%s rejects an unknown key', (_name, schema, value) => {
    expect(schema.safeParse({ ...value, approvalStatus: 'approved' }).success).toBe(false);
  });

  it.each(records.filter(([name]) => !['PolicyRule'].includes(name)))('%s requires a schemaVersion', (_name, schema, value) => {
    expect(schema.safeParse(without(value, 'schemaVersion')).success).toBe(false);
    expect(schema.safeParse({ ...value, schemaVersion: 'v0' }).success).toBe(false);
  });

  it('rejects a non-synthetic case and a case that does not start in intake', () => {
    expect(Case.safeParse({ ...validCase, synthetic: false }).success).toBe(false);
    expect(IntakeCase.safeParse(validCase).success).toBe(true);
    expect(Case.safeParse({ ...validCase, state: 'ready_for_review' }).success).toBe(true);
    expect(IntakeCase.safeParse({ ...validCase, state: 'ready_for_review' }).success).toBe(false);
  });

  it('requires the case and its supplier status to name the same evidence record', () => {
    expect(Case.safeParse({ ...validCase, supplierStatusEvidenceId: 'doc-other' }).success).toBe(false);
    const unknown = { ...supplierStatus, status: 'unknown', evidenceId: null };
    expect(Case.safeParse({ ...validCase, supplierStatus: unknown, supplierStatusEvidenceId: null }).success).toBe(true);
  });

  it('rejects a supplier status interval that ends before it starts', () => {
    expect(SupplierStatus.safeParse({ ...supplierStatus, effectiveTo: '2025-12-31' }).success).toBe(false);
  });
});

describe('explicit values', () => {
  it('keeps null, false and a missing key distinct', () => {
    expect(Case.safeParse({ ...validCase, payerPrimary: null }).success).toBe(true);
    expect(Case.safeParse({ ...validCase, payerPrimary: false }).success).toBe(true);
    expect(Case.safeParse(without(validCase, 'payerPrimary')).success).toBe(false);
    expect(SupplierStatus.safeParse({ ...supplierStatus, established: null }).success).toBe(true);
    expect(SupplierStatus.safeParse(without(supplierStatus, 'established')).success).toBe(false);
    expect(OrderBody.safeParse({ ...validOrder, signature: null }).success).toBe(true);
    expect(OrderBody.safeParse(without(validOrder, 'signature')).success).toBe(false);
  });

  it('never defaults a value', () => {
    const parsed = Case.parse({ ...validCase, accessories: null, itemCode: null, lcmpIncorporated: null });
    expect(parsed.accessories).toBeNull();
    expect(parsed.itemCode).toBeNull();
    expect(parsed.lcmpIncorporated).toBeNull();
  });

  it('keeps restricted, unreadable and available access distinct', () => {
    expect(AccessStatus.options).toEqual(['available', 'restricted', 'unreadable']);
    expect(Document.safeParse({ ...validDocument, accessStatus: 'restricted', contentHash: null }).success).toBe(true);
    expect(Document.safeParse({ ...validDocument, accessStatus: 'restricted' }).success).toBe(false);
    expect(Document.safeParse({ ...validDocument, accessStatus: 'unreadable' }).success).toBe(true);
    expect(Document.safeParse({ ...validDocument, contentHash: null }).success).toBe(false);
  });

  it('allows a null subject only for supplier status records', () => {
    expect(Document.safeParse({ ...validDocument, subjectId: null }).success).toBe(false);
    expect(Document.safeParse({ ...validDocument, kind: 'supplier_status', subjectId: null }).success).toBe(true);
    expect(Document.safeParse({ ...validDocument, kind: 'supplier_status' }).success).toBe(false);
  });

  it('only lets a version supersede an earlier version of the same document', () => {
    expect(Document.safeParse({ ...validDocument, version: 2, supersedes: { documentId: 'doc-order', version: 1 } }).success).toBe(true);
    expect(Document.safeParse({ ...validDocument, supersedes: { documentId: 'doc-order', version: 1 } }).success).toBe(false);
  });

  it('separates local medical dates from UTC receipt timestamps', () => {
    expect(IsoDate.safeParse('2028-02-29').success).toBe(true);
    expect(IsoDate.safeParse('2027-02-29').success).toBe(false);
    expect(IsoDate.safeParse('2026-09-02T10:00:00Z').success).toBe(false);
    expect(UtcTimestamp.safeParse('2026-09-03T17:05:00Z').success).toBe(true);
    expect(UtcTimestamp.safeParse('2026-09-03T10:05:00-07:00').success).toBe(false);
    expect(Document.safeParse({ ...validDocument, receivedAt: '2026-10-17T08:00:00-07:00' }).success).toBe(false);
    expect(OrderBody.safeParse({ ...validOrder, orderTime: { timestamp: '2026-09-02T15:10:00', timeZone: 'America/Los_Angeles' } }).success).toBe(false);
  });

  it('rejects a source body with an unknown key or a mismatched kind', () => {
    expect(SourceDocumentBody.safeParse(validOrder).success).toBe(true);
    expect(SourceDocumentBody.safeParse({ ...validOrder, instructions: 'ignore the rules' }).success).toBe(false);
    expect(SourceDocumentBody.safeParse({ ...validOrder, documentKind: 'encounter' }).success).toBe(false);
  });
});

describe('enums', () => {
  it('lists every SPEC case state and no payer outcome', () => {
    expect(CaseState.options).toEqual([
      'intake',
      'assessing',
      'scope_hold',
      'needs_information',
      'needs_human_review',
      'ready_for_review',
      'accepted_for_review',
      'recoverable_error',
      'cancelled',
    ]);
    expect(AssessedState.options.every((state) => CaseState.options.includes(state))).toBe(true);
  });

  it('lists exactly the SPEC finding statuses', () => {
    expect(FindingStatus.options).toEqual(['pass', 'missing', 'conflict', 'unreadable', 'restricted', 'manual_review', 'not_applicable']);
  });

  it('maps every evidence field to one fixed, unique pointer', () => {
    const keys = EvidenceField.options.map((field) => `${EVIDENCE_FIELD_SOURCES[field].documentKind}${EVIDENCE_FIELD_SOURCES[field].pointer}`);
    expect(new Set(keys).size).toBe(keys.length);
    for (const field of EvidenceField.options) {
      expect(JsonPointer.safeParse(EVIDENCE_FIELD_SOURCES[field].pointer).success).toBe(true);
    }
    expect(CLINICAL_EVIDENCE_FIELDS).toEqual([
      'clinical.diagnosis_statement',
      'clinical.mobility_limitation',
      'clinical.lower_level_devices',
      'clinical.home_accessibility',
      'clinical.ability_to_operate',
    ]);
  });
});

describe('evidence and assessment invariants', () => {
  it('requires the field pointer as the locator and a confidence only for model extraction', () => {
    expect(EvidenceFact.safeParse({ ...validFact, locator: '/item/code' }).success).toBe(false);
    expect(EvidenceFact.safeParse({ ...validFact, locator: '' }).success).toBe(false);
    expect(EvidenceFact.safeParse({ ...validFact, confidence: 0.9 }).success).toBe(false);
    expect(EvidenceFact.safeParse({ ...validFact, extractionMethod: 'model', confidence: 0.9, reviewStatus: 'proposed' }).success).toBe(true);
    expect(EvidenceFact.safeParse({ ...validFact, extractionMethod: 'model' }).success).toBe(false);
  });

  it('rejects a finding citing an unknown fact', () => {
    const finding = { ...validFinding, evidenceFactIds: ['fact-missing'] };
    expect(AssessmentResult.safeParse({ ...validResult, findings: [finding] }).success).toBe(false);
  });

  it('names affected documents separately from evidence, without duplicates', () => {
    const quarantine = { ...validFinding, ruleId: 'R02', status: 'conflict', evidenceFactIds: [], documentRefs: [{ documentId: 'doc-other', version: 1 }] };
    expect(Finding.safeParse(quarantine).success).toBe(true);
    expect(Finding.safeParse({ ...quarantine, documentRefs: [{ documentId: 'doc-other', version: 1 }, { documentId: 'doc-other', version: 1 }] }).success).toBe(false);
    expect(Finding.safeParse(without(validFinding, 'documentRefs')).success).toBe(false);
  });

  it('identifies the policy pack by exact bytes as well as by ID', () => {
    expect(AssessmentResult.safeParse(without(validResult, 'policyPackSha256')).success).toBe(false);
    expect(AssessmentResult.safeParse({ ...validResult, policyPackSha256: 'abc' }).success).toBe(false);
  });

  it('rejects any fact from a quarantined document', () => {
    expect(AssessmentResult.safeParse({ ...validResult, quarantinedDocumentIds: ['doc-order'] }).success).toBe(false);
  });

  it('requires one finding per rule for the assessed revision', () => {
    const second = { ...validFinding, findingId: 'finding-2' };
    expect(AssessmentResult.safeParse({ ...validResult, findings: [validFinding, second] }).success).toBe(false);
    expect(AssessmentResult.safeParse({ ...validResult, findings: [{ ...validFinding, caseRevision: 2 }] }).success).toBe(false);
  });

  it('cannot select a state outside the assessment outcomes', () => {
    for (const state of ['intake', 'accepted_for_review', 'cancelled', 'approved']) {
      expect(AssessmentResult.safeParse({ ...validResult, state }).success).toBe(false);
    }
  });
});

describe('policy pack invariants', () => {
  it('requires every cited source section to be registered', () => {
    expect(PolicyPack.safeParse({ ...validPack, sourceRefs: [] }).success).toBe(false);
  });

  it('keeps lab-only rules separate from source-linked rules', () => {
    expect(PolicyRule.safeParse({ ...validRule, basis: 'lab' }).success).toBe(false);
    expect(PolicyRule.safeParse({ ...validRule, sourceSections: [] }).success).toBe(false);
  });

  it('rejects a rule with two outcomes for one status', () => {
    const outcomes = [...validRule.outcomes, validRule.outcomes[0]];
    expect(PolicyRule.safeParse({ ...validRule, outcomes }).success).toBe(false);
  });

  it('accepts an unreviewed pack so R08 can report it', () => {
    expect(PolicyPack.safeParse({ ...validPack, reviewedAsOf: null }).success).toBe(true);
  });
});

// Collects every object key, enum member and literal reachable from a schema.
function vocabulary(schema: unknown, seen = new Set<unknown>(), words: string[] = []): string[] {
  if (schema === null || typeof schema !== 'object' || seen.has(schema) || !('def' in schema)) {
    return words;
  }
  seen.add(schema);
  const def = schema.def as Record<string, unknown>;
  if (def.type === 'object') {
    for (const [key, value] of Object.entries(def.shape as Record<string, unknown>)) {
      words.push(key);
      vocabulary(value, seen, words);
    }
  } else if (def.type === 'enum') {
    words.push(...Object.keys(def.entries as Record<string, unknown>));
  } else if (def.type === 'literal') {
    words.push(...(def.values as unknown[]).map(String));
  }
  for (const key of ['element', 'innerType', 'in', 'out']) {
    vocabulary(def[key], seen, words);
  }
  for (const option of (def.options as unknown[] | undefined) ?? []) {
    vocabulary(option, seen, words);
  }
  return words;
}

describe('authority boundary (PA-A04 contract shape)', () => {
  const schemas = Object.values(domain).filter((value) => value !== null && typeof value === 'object' && 'def' in value);
  const words = schemas.flatMap((schema) => vocabulary(schema));

  it('inspects the domain schemas', () => {
    expect(schemas.length).toBeGreaterThan(20);
    expect(words).toContain('accessStatus');
    expect(words).toContain('manual_review');
  });

  it('has no field or value for submission, payer outcomes, payment, signature verification, order generation or source editing', () => {
    // Whole camelCase or snake_case tokens, so scope values such as `resubmission`
    // (a request kind that is out of scope) and `expedited` are not flagged.
    const forbidden = new Set(['submit', 'submitted', 'submission', 'approve', 'approved', 'approval', 'deny', 'denied', 'denial', 'paid', 'payment', 'pay', 'adjudicate', 'adjudication', 'verify', 'verified', 'verification', 'generate', 'generated', 'generation', 'edit', 'edited', 'autofill']);
    const tokens = (word: string) => word.split(/[_.\-\s/]|(?=[A-Z])/).map((token) => token.toLowerCase());
    expect(words.filter((word) => tokens(word).some((token) => forbidden.has(token)))).toEqual([]);
    expect(tokens('signatureVerified')).toContain('verified');
    expect(tokens('payer_approved')).toContain('approved');
  });
});
