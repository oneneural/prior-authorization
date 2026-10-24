import { type Case, type FindingStatus, type RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  bytesOf,
  citationsOf,
  encounterBody,
  findingOf,
  noteBody,
  orderBody,
  receiptBody,
  refsOf,
  replace,
  run,
  source,
  statusOf,
  SUBJECT_ID,
  SUBJECT_NAME,
  supplierBody,
  supportedCase,
  supportedDocuments,
  testPack,
  without,
} from '../test/builders.js';
import { instantOf } from './calendar.js';
import { type SourceInput } from './documents.js';
import { webCryptoSha256 } from './hash.js';
import { orderDateSpan } from './rules.js';

async function assessWith(ruleId: RuleId, caseRecord: Case, documents: readonly SourceInput[]) {
  const result = await run(caseRecord, documents);
  return { result, finding: findingOf(result, ruleId), status: statusOf(result, ruleId) };
}

const withOrder = async (overrides: Parameters<typeof orderBody>[0]) => replace(await supportedDocuments(), 'order', await source('order', orderBody(overrides)));
const withEncounter = async (overrides: Parameters<typeof encounterBody>[0]) =>
  replace(await supportedDocuments(), 'encounter', await source('encounter', encounterBody(overrides)));
const withReceipt = async (overrides: Parameters<typeof receiptBody>[0]) => replace(await supportedDocuments(), 'receipt', await source('receipt', receiptBody(overrides)));
const withSupplier = async (overrides: Parameters<typeof supplierBody>[0]) =>
  replace(await supportedDocuments(), 'supplier-status', await source('supplier-status', supplierBody(overrides)));

describe('R01 supported scope', () => {
  const status = { ...supportedCase().supplierStatus };
  it.each<[string, Partial<Case>, FindingStatus]>([
    ['Medicare Advantage', { payerType: 'medicare_advantage' }, 'conflict'],
    ['secondary coverage', { payerPrimary: false }, 'conflict'],
    ['a non-CA beneficiary', { beneficiaryState: 'NV' }, 'conflict'],
    ['another jurisdiction', { jurisdiction: 'cgs_jc' }, 'conflict'],
    ['another item code', { itemCode: 'K0824' }, 'conflict'],
    ['a replacement', { requestKind: 'replacement' }, 'conflict'],
    ['an appeal', { requestKind: 'appeal' }, 'conflict'],
    ['expedited handling', { urgency: 'expedited' }, 'conflict'],
    ['accessories', { accessories: ['E1002'] }, 'conflict'],
    ['an already delivered item', { alreadyDelivered: true }, 'conflict'],
    ['an exempt supplier', { supplierStatus: { ...status, status: 'exempt' } }, 'conflict'],
    ['a new enrollment', { supplierStatus: { ...status, newEnrollment: true } }, 'conflict'],
    ['an ownership change', { supplierStatus: { ...status, ownershipChange: true } }, 'conflict'],
    ['a supplier that is not established', { supplierStatus: { ...status, established: false } }, 'conflict'],
    ['an unknown payer', { payerType: 'unknown' }, 'missing'],
    ['unknown primacy', { payerPrimary: null }, 'missing'],
    ['an unknown state', { beneficiaryState: 'unknown' }, 'missing'],
    ['an unknown jurisdiction', { jurisdiction: 'unknown' }, 'missing'],
    ['no item code', { itemCode: null }, 'missing'],
    ['unknown accessories', { accessories: null }, 'missing'],
    ['unknown delivery', { alreadyDelivered: null }, 'missing'],
    ['unknown LCMP incorporation', { lcmpIncorporated: null }, 'missing'],
    ['an unknown exemption', { supplierStatus: { ...status, status: 'unknown' } }, 'missing'],
  ])('holds scope for %s', async (_, overrides, expected) => {
    const caseRecord = supportedCase(overrides);
    const documents = await supportedDocuments();
    const { result, finding } = await assessWith('R01', caseRecord, documents);
    // A differing case value also differs from the supplier record, which is a conflict too.
    expect(finding.status).toBe(overrides.supplierStatus?.status === 'unknown' ? 'conflict' : expected);
    expect(finding.responsibleRole).toBe('authorization_coordinator');
    expect(finding.documentRefs).toEqual([]);
    expect(result.state).toBe('scope_hold');
  });

  it('accepts a stated LCMP incorporation, which R07 routes instead', async () => {
    const { result, status } = await assessWith('R01', supportedCase({ lcmpIncorporated: true }), await supportedDocuments());
    expect(status).toBe('pass');
    expect(result.state).toBe('needs_human_review');
  });

  it.each([
    ['an expired interval', { effectiveFrom: '2025-01-01', effectiveTo: '2026-10-17' }, 'expired before the assessment date'],
    ['an interval not yet effective', { effectiveFrom: '2026-10-19', effectiveTo: '2027-12-31' }, 'not yet effective'],
  ])('holds scope for %s in both the case and its record', async (_, interval, text) => {
    const caseRecord = supportedCase({ supplierStatus: { ...status, ...interval } });
    const { finding } = await assessWith('R01', caseRecord, await withSupplier(interval));
    expect(finding.status).toBe('conflict');
    expect(finding.explanation).toContain(text);
  });

  it('includes the assessment date at both interval bounds', async () => {
    const interval = { effectiveFrom: '2026-10-18', effectiveTo: '2026-10-18' };
    const { status } = await assessWith('R01', supportedCase({ supplierStatus: { ...supportedCase().supplierStatus, ...interval } }), await withSupplier(interval));
    expect(status).toBe('pass');
  });

  it('reports a missing interval bound', async () => {
    const caseRecord = supportedCase({ supplierStatus: { ...status, effectiveTo: null } });
    const { finding } = await assessWith('R01', caseRecord, await withSupplier({ effectiveTo: null }));
    expect(finding.status).toBe('missing');
  });

  it('holds scope when the case and its supplier record disagree', async () => {
    const differing = await assessWith('R01', supportedCase(), await withSupplier({ ownershipChange: true }));
    expect(differing.status).toBe('conflict');
    expect(differing.finding.explanation).toContain('differs from supplier status record supplier-status v1 in ownershipChange');
    const otherSupplier = await assessWith('R01', supportedCase(), await withSupplier({ supplierId: 'SYN-SUP-0002' }));
    expect(otherSupplier.finding.explanation).toContain('case supplierId differs');
    expect(otherSupplier.status).toBe('conflict');
  });

  it('holds scope when the order states another item code', async () => {
    const { finding } = await assessWith('R01', supportedCase(), await withOrder({ item: { description: 'Synthetic chair', code: 'K0824', quantity: 1 } }));
    expect(finding.status).toBe('conflict');
    expect(finding.explanation).toContain('states item code K0824');
  });

  it('reports a missing, restricted or unreadable supplier record distinctly', async () => {
    const absent = await assessWith('R01', supportedCase(), without(await supportedDocuments(), 'supplier-status'));
    expect([absent.status, absent.finding.documentRefs]).toEqual(['missing', []]);
    const restricted = replace(await supportedDocuments(), 'supplier-status', await source('supplier-status', supplierBody(), { meta: { accessStatus: 'restricted' } }));
    const restrictedResult = await assessWith('R01', supportedCase(), restricted);
    expect([restrictedResult.status, refsOf(restrictedResult.result, 'R01')]).toEqual(['restricted', ['supplier-status@v1']]);
    const unreadable = replace(await supportedDocuments(), 'supplier-status', await source('supplier-status', supplierBody(), { meta: { mimeType: 'text/plain' } }));
    const unreadableResult = await assessWith('R01', supportedCase(), unreadable);
    expect([unreadableResult.status, refsOf(unreadableResult.result, 'R01')]).toEqual(['unreadable', ['supplier-status@v1']]);
    expect(unreadableResult.result.state).toBe('scope_hold');
    const tampered = replace(await supportedDocuments(), 'supplier-status', await source('supplier-status', supplierBody(), { bytes: bytesOf(supplierBody({ status: 'exempt' })) }));
    const tamperedResult = await assessWith('R01', supportedCase(), tampered);
    expect([tamperedResult.status, tamperedResult.finding.documentRefs, statusOf(tamperedResult.result, 'R09')]).toEqual(['missing', [], 'conflict']);
  });

  it('reports a case naming no supplier record', async () => {
    const caseRecord = supportedCase({ supplierStatus: { ...status, evidenceId: null }, supplierStatusEvidenceId: null });
    const { finding } = await assessWith('R01', caseRecord, await supportedDocuments());
    expect(finding.status).toBe('missing');
    expect(finding.explanation).toContain('no supplier status evidence record is named');
  });
});

describe('R02 subject binding', () => {
  it.each([
    ['metadata naming another subject', {}, { subjectId: 'SYN-BEN-X900' }, 'metadata subjectId differs'],
    ['a stated identifier of another subject', { beneficiary: { name: SUBJECT_NAME, identifier: 'SYN-BEN-X900' } }, {}, 'beneficiary identifier differs'],
    ['a stated name of another subject', { beneficiary: { name: 'Morgan Othercase', identifier: SUBJECT_ID } }, {}, 'beneficiary name differs'],
    ['a formatting difference in the name', { beneficiary: { name: 'riley testcase', identifier: SUBJECT_ID } }, {}, 'beneficiary name differs'],
  ])('quarantines a document with %s', async (_, body, meta, reason) => {
    const receipt = await source('receipt', receiptBody(body), { meta });
    const { result, finding } = await assessWith('R02', supportedCase(), replace(await supportedDocuments(), 'receipt', receipt));
    expect(finding).toMatchObject({ status: 'conflict', responsibleRole: 'administrative_reviewer', documentRefs: [{ documentId: 'receipt', version: 1 }] });
    expect(finding.explanation).toContain(reason);
    expect(result.quarantinedDocumentIds).toEqual(['receipt']);
    expect(citationsOf(result, 'R02').some((citation) => citation.startsWith('receipt@'))).toBe(false);
    expect(statusOf(result, 'R05')).toBe('missing');
    expect(result.state).toBe('needs_human_review');
  });

  it('binds a body stating only the name, or only the identifier', async () => {
    const nameOnly = await assessWith('R02', supportedCase(), await withOrder({ beneficiary: { name: SUBJECT_NAME, identifier: null } }));
    expect(nameOnly.status).toBe('pass');
    expect(citationsOf(nameOnly.result, 'R02')).toContain('order@v1/beneficiary/name');
    const identifierOnly = await assessWith('R02', supportedCase(), await withOrder({ beneficiary: { name: null, identifier: SUBJECT_ID } }));
    expect(identifierOnly.status).toBe('pass');
  });

  it('exempts supplier status records, which concern no beneficiary', async () => {
    const { status, result } = await assessWith('R02', supportedCase(), await supportedDocuments());
    expect(status).toBe('pass');
    expect(citationsOf(result, 'R01')).toContain('supplier-status@v1/supplierId');
  });
});

describe('R03 existing order elements', () => {
  it.each([
    ['the beneficiary name alone', { beneficiary: { name: SUBJECT_NAME, identifier: null } }],
    ['the beneficiary identifier alone', { beneficiary: { name: null, identifier: SUBJECT_ID } }],
    ['the practitioner name alone', { treatingPractitioner: { name: 'Casey Example, MD (synthetic)', identifier: null } }],
    ['a draft order', { status: 'draft' as const }],
  ])('passes with %s', async (_, overrides) => {
    expect((await assessWith('R03', supportedCase(), await withOrder(overrides))).status).toBe('pass');
  });

  it.each([
    ['no beneficiary', { beneficiary: { name: null, identifier: null } }, 'the beneficiary name or identifier'],
    ['no order date', { orderDate: null }, 'the order date'],
    ['no item description', { item: { description: null, code: 'K0823', quantity: 1 } }, 'an item description'],
    ['no quantity', { item: { description: 'Synthetic chair', code: 'K0823', quantity: null } }, 'a quantity'],
    ['no practitioner', { treatingPractitioner: { name: null, identifier: null } }, 'the treating practitioner name or identifier'],
    ['no signature metadata', { signature: null }, 'signature metadata'],
  ])('reports %s as missing without filling it', async (_, overrides, element) => {
    const { finding, result } = await assessWith('R03', supportedCase(), await withOrder(overrides));
    expect(finding).toMatchObject({ status: 'missing', responsibleRole: 'authorization_coordinator', documentRefs: [] });
    expect(finding.explanation).toContain(element);
    expect(finding.explanation).not.toMatch(/verified/i);
    expect(result.state).not.toBe('ready_for_review');
  });

  it('reports a conflict when two unsuperseded orders disagree, and none once one supersedes the other', async () => {
    const second = await source('order-2', orderBody({ orderDate: '2026-09-04' }));
    const conflicting = await assessWith('R03', supportedCase(), [...(await supportedDocuments()), second]);
    expect(conflicting.status).toBe('conflict');
    expect(conflicting.finding.explanation).toContain('order date');
    const superseding = await source('order-2', orderBody({ orderDate: '2026-09-04' }), { meta: { supersedes: { documentId: 'order', version: 1 } } });
    const receipt = await source('receipt', receiptBody({ orderReference: { documentId: 'order-2', version: 1 }, receivedAt: '2026-09-05T17:00:00Z' }));
    const resolved = await assessWith('R03', supportedCase(), [...replace(await supportedDocuments(), 'receipt', receipt), superseding]);
    expect(resolved.status).toBe('pass');
    expect(resolved.result.state).toBe('ready_for_review');
  });

  it.each<[string, Parameters<typeof source>[2], FindingStatus]>([
    ['restricted', { meta: { accessStatus: 'restricted' } }, 'restricted'],
    ['unreadable', { meta: { accessStatus: 'unreadable' } }, 'unreadable'],
    ['plain text', { meta: { mimeType: 'text/plain' } }, 'unreadable'],
    ['not valid JSON', { bytes: new TextEncoder().encode('{"documentKind": "order"') }, 'unreadable'],
  ])('names the only order when it is %s', async (_, options, expected) => {
    const order = await source('order', orderBody(), options);
    // Bytes held by the source system are hashed as they are, so only readability fails.
    const bytes = options?.bytes;
    const held = bytes === undefined || bytes === null ? order : { ...order, meta: { ...order.meta, contentHash: await webCryptoSha256(bytes) } };
    const { finding } = await assessWith('R03', supportedCase(), replace(await supportedDocuments(), 'order', held));
    expect(finding.status).toBe(expected);
    expect(finding.documentRefs).toEqual([{ documentId: 'order', version: 1 }]);
    expect(finding.responsibleRole).toBe('authorization_coordinator');
  });
});

describe('R04 encounter and order chronology', () => {
  const pair = async (encounter: Parameters<typeof encounterBody>[0], order: Parameters<typeof orderBody>[0], receivedAt = '2027-12-31T12:00:00Z') => {
    const documents = replace(
      replace(await supportedDocuments(), 'encounter', await source('encounter', encounterBody(encounter))),
      'order',
      await source('order', orderBody(order)),
    );
    return assessWith('R04', supportedCase(), replace(documents, 'receipt', await source('receipt', receiptBody({ receivedAt }))));
  };

  it.each<[string, string, string, FindingStatus]>([
    ['the day after the encounter', '2026-08-20', '2026-08-21', 'pass'],
    ['exactly six calendar months later (inclusive)', '2026-08-20', '2027-02-20', 'pass'],
    ['one day past six calendar months', '2026-08-20', '2027-02-21', 'conflict'],
    ['the clamped month end (2026-03-31 to 2026-09-30)', '2026-03-31', '2026-09-30', 'pass'],
    ['one day past the clamped month end', '2026-03-31', '2026-10-01', 'conflict'],
    ['the leap day bound (2027-08-31 to 2028-02-29)', '2027-08-31', '2028-02-29', 'pass'],
    ['one day past the leap day bound', '2027-08-31', '2028-03-01', 'conflict'],
    ['a non-leap February bound (2025-08-31 to 2026-02-28)', '2025-08-31', '2026-02-28', 'pass'],
    ['a day before the encounter', '2026-08-20', '2026-08-19', 'conflict'],
    ['the same day without times', '2026-08-20', '2026-08-20', 'manual_review'],
  ])('orders %s: %s to %s is %s', async (_, encounterDate, orderDate, expected) => {
    const { finding, result } = await pair({ encounterDate }, { orderDate });
    expect(finding.status).toBe(expected);
    if (expected !== 'pass') {
      expect(result.state).toBe('needs_human_review');
    }
  });

  it('sequences a same-day order only with explicit times placing it after completion (C02)', async () => {
    const encounter = { encounterDate: '2026-08-20', completionTime: { timestamp: '2026-08-20T10:00:00-07:00', timeZone: 'America/Los_Angeles' } };
    const after = await pair(encounter, { orderDate: '2026-08-20', orderTime: { timestamp: '2026-08-20T17:30:00Z', timeZone: 'UTC' } });
    expect(after.status).toBe('pass');
    const before = await pair(encounter, { orderDate: '2026-08-20', orderTime: { timestamp: '2026-08-20T16:59:59Z', timeZone: 'UTC' } });
    expect(before.status).toBe('manual_review');
    const equal = await pair(encounter, { orderDate: '2026-08-20', orderTime: { timestamp: '2026-08-20T17:00:00Z', timeZone: 'UTC' } });
    expect(equal.status).toBe('manual_review');
    const orderTimeOnly = await pair({ encounterDate: '2026-08-20' }, { orderDate: '2026-08-20', orderTime: { timestamp: '2026-08-20T17:30:00Z', timeZone: 'UTC' } });
    expect(orderTimeOnly.status).toBe('manual_review');
  });

  it('compares practitioners by identifier only (C03)', async () => {
    const differing = await pair({ practitioner: { name: 'Casey Example, MD (synthetic)', identifier: 'SYN-PRAC-0002' } }, {});
    expect(differing.status).toBe('conflict');
    const nameOnly = await pair({}, { treatingPractitioner: { name: 'Casey Example, MD (synthetic)', identifier: null } });
    expect(nameOnly.status).toBe('manual_review');
    expect(statusOf(nameOnly.result, 'R03')).toBe('pass');
  });

  it('routes the LCMP branch to review without simplifying chronology (C04)', async () => {
    const { finding, result } = await pair({ lcmpReport: { incorporated: true, evaluationDate: '2026-08-10' } }, {});
    expect(finding.status).toBe('manual_review');
    expect(finding.explanation).toContain('C04');
    expect(statusOf(result, 'R07')).toBe('manual_review');
  });

  it.each([
    ['a draft encounter', { status: 'draft' as const }, {}],
    ['a draft order', {}, { status: 'draft' as const }],
    ['no encounter date', { encounterDate: null }, {}],
    ['no order date', {}, { orderDate: null }],
  ])('reports %s as missing', async (_, encounter, order) => {
    expect((await pair(encounter, order)).status).toBe('missing');
  });

  it('reports missing, restricted and provenance-failed encounters distinctly', async () => {
    const absent = await assessWith('R04', supportedCase(), without(await supportedDocuments(), 'encounter'));
    expect(absent.status).toBe('missing');
    const restricted = await assessWith('R04', supportedCase(), replace(await supportedDocuments(), 'encounter', await source('encounter', encounterBody(), { meta: { accessStatus: 'restricted' } })));
    expect([restricted.status, refsOf(restricted.result, 'R04')]).toEqual(['restricted', ['encounter@v1']]);
    const kindMismatch = await source('encounter', orderBody(), { meta: { kind: 'encounter' } });
    const failed = await assessWith('R04', supportedCase(), replace(await supportedDocuments(), 'encounter', kindMismatch));
    expect([failed.status, refsOf(failed.result, 'R04'), statusOf(failed.result, 'R09')]).toEqual(['manual_review', ['encounter@v1'], 'conflict']);
    expect(findingOf(failed.result, 'R09').explanation).toContain('body kind order differs from its metadata kind encounter');
  });

  it('reports disagreeing unsuperseded encounters as a conflict', async () => {
    const second = await source('encounter-2', encounterBody({ encounterDate: '2026-08-22' }));
    expect((await assessWith('R04', supportedCase(), [...(await supportedDocuments()), second])).status).toBe('conflict');
  });
});

describe('R05 supplier receipt (C06)', () => {
  it('computes the order date span across time zones', () => {
    expect(orderDateSpan('2026-03-01')).toEqual({ start: instantOf('2026-02-28T10:00:00Z'), end: instantOf('2026-03-02T12:00:00Z') });
  });

  it.each<[string, Parameters<typeof receiptBody>[0], Parameters<typeof orderBody>[0], FindingStatus]>([
    ['after the order date span', { receivedAt: '2026-09-03T12:00:01Z' }, {}, 'pass'],
    ['at the end of the span', { receivedAt: '2026-09-03T12:00:00Z' }, {}, 'manual_review'],
    ['within the span', { receivedAt: '2026-09-02T08:00:00Z' }, {}, 'manual_review'],
    ['at the start of the span', { receivedAt: '2026-09-01T10:00:00Z' }, {}, 'manual_review'],
    ['before the span', { receivedAt: '2026-09-01T09:59:59Z' }, {}, 'conflict'],
    ['after a stated order time', { receivedAt: '2026-09-02T18:00:00Z' }, { orderTime: { timestamp: '2026-09-02T10:00:00-07:00', timeZone: 'America/Los_Angeles' } }, 'pass'],
    ['before a stated order time', { receivedAt: '2026-09-02T16:59:00Z' }, { orderTime: { timestamp: '2026-09-02T10:00:00-07:00', timeZone: 'America/Los_Angeles' } }, 'conflict'],
    ['at the same instant as a stated order time', { receivedAt: '2026-09-02T17:00:00Z' }, { orderTime: { timestamp: '2026-09-02T10:00:00-07:00', timeZone: 'America/Los_Angeles' } }, 'manual_review'],
    ['without a receipt time', { receivedAt: null }, {}, 'missing'],
    ['referencing another order version', { orderReference: { documentId: 'order', version: 2 } }, {}, 'missing'],
    ['referencing no order', { orderReference: null }, {}, 'missing'],
  ])('receipt %s', async (_, receipt, order, expected) => {
    const documents = replace(await withReceipt(receipt), 'order', await source('order', orderBody(order)));
    const { finding, result } = await assessWith('R05', supportedCase(), documents);
    expect(finding.status).toBe(expected);
    expect(finding.documentRefs).toEqual([]);
    expect(result.state).toBe(expected === 'pass' ? 'ready_for_review' : expected === 'missing' ? 'needs_information' : 'needs_human_review');
  });

  it('reports absent receipt evidence without a delivery claim', async () => {
    const { finding } = await assessWith('R05', supportedCase(), without(await supportedDocuments(), 'receipt'));
    expect(finding.status).toBe('missing');
    expect(finding.explanation).toContain('nothing is concluded about delivery');
  });

  it('names the only receipt when it failed provenance or is restricted', async () => {
    const tampered = await source('receipt', receiptBody(), { bytes: bytesOf(receiptBody({ receivedAt: '2026-09-04T17:05:00Z' })) });
    const failed = await assessWith('R05', supportedCase(), replace(await supportedDocuments(), 'receipt', tampered));
    expect([failed.status, refsOf(failed.result, 'R05')]).toEqual(['manual_review', ['receipt@v1']]);
    const restricted = await assessWith('R05', supportedCase(), replace(await supportedDocuments(), 'receipt', await source('receipt', receiptBody(), { meta: { accessStatus: 'restricted' } })));
    expect([restricted.status, refsOf(restricted.result, 'R05')]).toEqual(['restricted', ['receipt@v1']]);
  });

  it('accepts receipt of a draft order as R05 evidence (C05) while R04 still needs a final one', async () => {
    const { status, result } = await assessWith('R05', supportedCase(), await withOrder({ status: 'draft' }));
    expect(status).toBe('pass');
    expect(statusOf(result, 'R04')).toBe('missing');
  });
});

describe('R06 clinical evidence', () => {
  it('always routes clinical facts to qualified review without blocking readiness', async () => {
    const { finding, result } = await assessWith('R06', supportedCase(), await supportedDocuments());
    expect(finding).toMatchObject({ status: 'manual_review', responsibleRole: 'qualified_clinical_reviewer', severity: 'non_blocking' });
    expect(citationsOf(result, 'R06').every((citation) => citation.includes('/clinical/'))).toBe(true);
    expect(finding.explanation).toContain('no medical necessity conclusion');
    expect(result.state).toBe('ready_for_review');
  });

  it('does not read an unavailable record as clinical absence', async () => {
    const restricted = replace(await supportedDocuments(), 'encounter', await source('encounter', encounterBody(), { meta: { accessStatus: 'restricted' } }));
    const { finding, result } = await assessWith('R06', supportedCase(), restricted);
    expect(finding.status).toBe('manual_review');
    expect(finding.evidenceFactIds).toEqual([]);
    expect(finding.explanation).toContain('not evidence that a clinical fact is absent');
    expect(result.state).toBe('needs_information');
  });
});

describe('R07 checklist items and LCMP', () => {
  it('states the pass from the pack scope', async () => {
    const pack = testPack();
    const wider = testPack({ scope: { ...pack.scope, itemCodes: ['K0823', 'K0824'], requestKinds: ['initial', 'replacement'] } });
    const result = await run(supportedCase(), await supportedDocuments(), { pack: wider });
    expect(findingOf(result, 'R07').explanation).toContain('required for initial or replacement K0823 or K0824 packets');
  });

  it('imposes no ATP, specialty, home assessment or proof-of-delivery requirement from a checklist worksheet', async () => {
    const worksheet = await source('worksheet', noteBody());
    const { status, result } = await assessWith('R07', supportedCase(), [...(await supportedDocuments()), worksheet]);
    expect(status).toBe('pass');
    expect(result.state).toBe('ready_for_review');
    expect(citationsOf(result, 'R02')).toEqual(expect.arrayContaining(['worksheet@v1/beneficiary/name', 'worksheet@v1/beneficiary/identifier']));
  });

  it.each([
    ['the case', supportedCase({ lcmpIncorporated: true }), {}],
    ['the encounter', supportedCase(), { lcmpReport: { incorporated: true, evaluationDate: '2026-08-10' } }],
  ])('routes LCMP incorporation stated by %s to human review', async (_, caseRecord, encounter) => {
    const { finding, result } = await assessWith('R07', caseRecord, await withEncounter(encounter));
    expect(finding).toMatchObject({ status: 'manual_review', responsibleRole: 'administrative_reviewer' });
    expect([statusOf(result, 'R01'), statusOf(result, 'R04'), result.state]).toEqual(['pass', 'manual_review', 'needs_human_review']);
  });
});

describe('R08 policy snapshot', () => {
  it('holds scope for another pack, an unsupported date or an unreviewed pack', async () => {
    const documents = await supportedDocuments();
    const otherPack = await run(supportedCase({ policyPackId: 'another-pack' }), documents);
    expect([statusOf(otherPack, 'R08'), otherPack.state]).toEqual(['conflict', 'scope_hold']);
    const otherDate = await run(supportedCase({ assessmentDate: '2026-10-19' }), documents);
    expect([statusOf(otherDate, 'R08'), otherDate.state]).toEqual(['conflict', 'scope_hold']);
    const unreviewed = await run(supportedCase(), documents, { pack: testPack({ reviewedAsOf: null }) });
    expect([statusOf(unreviewed, 'R08'), unreviewed.state]).toEqual(['missing', 'scope_hold']);
    const unsourced = await run(supportedCase(), documents, { pack: testPack({ sourceRefs: [] }) });
    expect(statusOf(unsourced, 'R08')).toBe('missing');
  });
});

describe('R09 access and provenance', () => {
  it('takes conflict, then restricted, then unreadable, and names every affected document', async () => {
    const documents = await supportedDocuments();
    const tampered = await source('encounter', encounterBody(), { bytes: bytesOf(encounterBody({ encounterDate: '2026-08-21' })) });
    const restricted = await source('receipt', receiptBody(), { meta: { accessStatus: 'restricted' } });
    const unreadable = await source('note', noteBody(), { meta: { accessStatus: 'unreadable' } });
    const all = await run(supportedCase(), [...replace(replace(documents, 'encounter', tampered), 'receipt', restricted), unreadable]);
    expect(findingOf(all, 'R09')).toMatchObject({ status: 'conflict', responsibleRole: 'administrative_reviewer' });
    expect(refsOf(all, 'R09')).toEqual(['encounter@v1', 'receipt@v1', 'note@v1']);
    const withoutConflict = await run(supportedCase(), [...replace(documents, 'receipt', restricted), unreadable]);
    expect([statusOf(withoutConflict, 'R09'), refsOf(withoutConflict, 'R09')]).toEqual(['restricted', ['receipt@v1', 'note@v1']]);
    const onlyUnreadable = await run(supportedCase(), [...documents, unreadable]);
    expect([statusOf(onlyUnreadable, 'R09'), onlyUnreadable.state]).toEqual(['unreadable', 'needs_information']);
  });

  it('reports a body that is not a valid structured source as unreadable', async () => {
    const invalidBody = { ...orderBody(), extra: 'not in the contract' };
    const bytes = bytesOf(invalidBody);
    const order = await source('order', bytes, { meta: { kind: 'order' } });
    const { result } = await assessWith('R09', supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect([statusOf(result, 'R09'), statusOf(result, 'R03')]).toEqual(['unreadable', 'unreadable']);
    expect(findingOf(result, 'R09').explanation).toContain('not a valid structured source body');
  });

  it('reports invalid UTF-8 as unreadable', async () => {
    const bytes = new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d]);
    const order = await source('order', bytes, { meta: { kind: 'order' } });
    const { result } = await assessWith('R09', supportedCase(), replace(await supportedDocuments(), 'order', order));
    expect(statusOf(result, 'R09')).toBe('unreadable');
  });
});

describe('R10 duplicate and stale actions', () => {
  it('is not applicable to a pure assessment', async () => {
    const { finding } = await assessWith('R10', supportedCase(), await supportedDocuments());
    expect(finding).toMatchObject({ status: 'not_applicable', evidenceFactIds: [], documentRefs: [], severity: 'non_blocking' });
  });
});
