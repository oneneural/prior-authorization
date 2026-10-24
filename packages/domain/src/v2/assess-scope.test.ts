import { type CaseV2 } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  assessDocuments,
  assessed,
  citationsOf,
  citingPackV2,
  conditionsOf,
  declaredUnreadable,
  encounter,
  order,
  packet,
  parentOf,
  plainText,
  READY,
  receipt,
  restricted,
  routingOf,
  sorted,
  statusesOf,
  supplier,
  tampered,
} from '../../test/builders-assess-v2.js';
import { bytesOf, caseV2, documentV2, orderBody, packV2 } from '../../test/builders-v2.js';
import { webCryptoSha256 } from '../hash.js';

// R01 (scope) and R08 (policy snapshot) through the public `assessV2`, on
// original synthetic inputs. A scope hold never suppresses another rule.

const withSupplier = (status: Partial<CaseV2['supplierStatus']>, overrides: Partial<CaseV2> = {}) => caseV2({ supplierStatus: { ...caseV2().supplierStatus, ...status }, ...overrides });

const SUPPLIER_FACTS = ['/effectiveFrom', '/effectiveTo', '/established', '/newEnrollment', '/ownershipChange', '/status', '/supplierId'].map((locator) => `supplier-status@1${locator}`);

describe('R01 case scope fields', () => {
  const UNSUPPORTED: [string, CaseV2, string[]][] = [
    ['case.payerType', caseV2({ payerType: 'commercial' }), []],
    ['case.payerPrimary', caseV2({ payerPrimary: false }), []],
    ['case.beneficiaryState', caseV2({ beneficiaryState: 'NV' }), []],
    ['case.jurisdiction', caseV2({ jurisdiction: 'cgs_jc' }), []],
    ['case.itemCode', caseV2({ itemCode: 'K0822' }), ['R01.order_item_code_disagrees|-|order@1']],
    ['case.requestKind', caseV2({ requestKind: 'replacement' }), []],
    ['case.urgency', caseV2({ urgency: 'expedited' }), []],
    ['case.accessories', caseV2({ accessories: ['E2300'] }), []],
    ['case.alreadyDelivered', caseV2({ alreadyDelivered: true }), []],
    ['case.supplierStatus.status', withSupplier({ status: 'exempt' }), ['R01.supplier_record_disagrees|supplier.status|supplier-status@1']],
    ['case.supplierStatus.established', withSupplier({ established: false }), ['R01.supplier_record_disagrees|supplier.established|supplier-status@1']],
    ['case.supplierStatus.newEnrollment', withSupplier({ newEnrollment: true }), ['R01.supplier_record_disagrees|supplier.new_enrollment|supplier-status@1']],
    ['case.supplierStatus.ownershipChange', withSupplier({ ownershipChange: true }), ['R01.supplier_record_disagrees|supplier.ownership_change|supplier-status@1']],
  ];

  it.each(UNSUPPORTED)('holds scope_fact_unsupported for a known %s outside the pack scope, keeping every other rule', async (field, caseRecord, alsoHeld) => {
    const result = await assessed(await packet(), { caseRecord });
    expect(conditionsOf(result, 'R01')).toEqual(sorted([`R01.scope_fact_unsupported|${field}|`, ...alsoHeld]));
    expect(routingOf(result, 'R01')).toBe('conflict/authorization_coordinator');
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R01: 'conflict' });
    expect(parentOf(result, 'R01')).toEqual([]);
  });

  const UNKNOWN: [string, CaseV2][] = [
    ['case.payerType', caseV2({ payerType: 'unknown' })],
    ['case.payerPrimary', caseV2({ payerPrimary: null })],
    ['case.beneficiaryState', caseV2({ beneficiaryState: 'unknown' })],
    ['case.jurisdiction', caseV2({ jurisdiction: 'unknown' })],
    ['case.itemCode', caseV2({ itemCode: null })],
    ['case.requestKind', caseV2({ requestKind: 'unknown' })],
    ['case.urgency', caseV2({ urgency: 'unknown' })],
    ['case.accessories', caseV2({ accessories: null })],
    ['case.alreadyDelivered', caseV2({ alreadyDelivered: null })],
    ['case.lcmpIncorporated', caseV2({ lcmpIncorporated: null })],
    ['case.supplierStatusEvidenceId', withSupplier({ evidenceId: null }, { supplierStatusEvidenceId: null })],
    ['case.supplierStatus.status', withSupplier({ status: 'unknown' })],
    ['case.supplierStatus.established', withSupplier({ established: null })],
    ['case.supplierStatus.newEnrollment', withSupplier({ newEnrollment: null })],
    ['case.supplierStatus.ownershipChange', withSupplier({ ownershipChange: null })],
    ['case.supplierStatus.effectiveFrom', withSupplier({ effectiveFrom: null })],
    ['case.supplierStatus.effectiveTo', withSupplier({ effectiveTo: null })],
  ];

  it.each(UNKNOWN)('holds only scope_fact_unknown for a null or unknown %s, never unsupported or a disagreement', async (field, caseRecord) => {
    const result = await assessed(await packet(), { caseRecord });
    expect(conditionsOf(result, 'R01')).toEqual([`R01.scope_fact_unknown|${field}|`]);
    expect(routingOf(result, 'R01')).toBe('missing/authorization_coordinator');
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R01: 'missing' });
  });

  it('passes a supported case and cites the named record and the order item code', async () => {
    const result = await assessed(await packet());
    expect(conditionsOf(result, 'R01')).toEqual([]);
    expect(routingOf(result, 'R01')).toBe('pass/administrative_reviewer');
    expect(citationsOf(result, 'R01')).toEqual(sorted([...SUPPLIER_FACTS, 'order@1/item/code']));
  });

  it('treats a stated LCMP incorporation as no scope failure', async () => {
    const result = await assessed(await packet(), { caseRecord: caseV2({ lcmpIncorporated: true }) });
    expect(conditionsOf(result, 'R01')).toEqual([]);
  });
});

describe('R01 supplier intervals (inclusive)', () => {
  const CASES: [string, string, string, boolean][] = [
    ['starting on the assessment date', '2026-10-18', '2026-12-31', false],
    ['ending on the assessment date', '2026-01-01', '2026-10-18', false],
    ['of that one day', '2026-10-18', '2026-10-18', false],
    ['not yet effective', '2026-10-19', '2026-12-31', true],
    ['expired the day before', '2026-01-01', '2026-10-17', true],
  ];

  it.each(CASES)('judges a case and record interval %s', async (_label, effectiveFrom, effectiveTo, excluded) => {
    const result = await assessed([await order(), await encounter(), await receipt(), await supplier('supplier-status', { effectiveFrom, effectiveTo })], {
      caseRecord: withSupplier({ effectiveFrom, effectiveTo }),
    });
    expect(conditionsOf(result, 'R01')).toEqual(excluded ? ['R01.case_supplier_interval_excludes_date|-|', 'R01.supplier_record_interval_excludes_date|-|supplier-status@1'] : []);
  });

  it('judges the record interval separately from a case interval that contains the date', async () => {
    const result = await assessed([await order(), await encounter(), await receipt(), await supplier('supplier-status', { effectiveTo: '2026-10-17' })]);
    expect(conditionsOf(result, 'R01')).toEqual(['R01.supplier_record_disagrees|supplier.effective_to|supplier-status@1', 'R01.supplier_record_interval_excludes_date|-|supplier-status@1']);
  });

  it('judges no interval with only one stated bound', async () => {
    const result = await assessed([await order(), await encounter(), await receipt(), await supplier('supplier-status', { effectiveFrom: '2026-10-19', effectiveTo: null })], {
      caseRecord: withSupplier({ effectiveFrom: '2026-10-19', effectiveTo: null }),
    });
    expect(conditionsOf(result, 'R01')).toEqual(['R01.scope_fact_unknown|case.supplierStatus.effectiveTo|', 'R01.supplier_record_value_unknown|supplier.effective_to|supplier-status@1']);
  });
});

describe('R01 named supplier record', () => {
  const others = async () => [await order(), await encounter(), await receipt()];

  it('holds supplier_id_disagrees for a record naming another supplier', async () => {
    const result = await assessed([...(await others()), await supplier('supplier-status', { supplierId: 'SYN-SUP-0002' })]);
    expect(conditionsOf(result, 'R01')).toEqual(['R01.supplier_id_disagrees|-|supplier-status@1']);
    expect(parentOf(result, 'R01')).toEqual([]);
  });

  const DISAGREE: [string, Parameters<typeof supplier>[1]][] = [
    ['supplier.status', { status: 'exempt' }],
    ['supplier.established', { established: false }],
    ['supplier.new_enrollment', { newEnrollment: true }],
    ['supplier.ownership_change', { ownershipChange: true }],
    ['supplier.effective_from', { effectiveFrom: '2026-02-01' }],
    ['supplier.effective_to', { effectiveTo: '2026-11-30' }],
  ];

  it.each(DISAGREE)('holds supplier_record_disagrees for a known %s that differs from the known case value', async (field, body) => {
    const result = await assessed([...(await others()), await supplier('supplier-status', body)]);
    expect(conditionsOf(result, 'R01')).toEqual([`R01.supplier_record_disagrees|${field}|supplier-status@1`]);
    expect(routingOf(result, 'R01')).toBe('conflict/authorization_coordinator');
  });

  const CASE_UNKNOWN: [string, Parameters<typeof supplier>[1], Partial<CaseV2['supplierStatus']>, string][] = [
    ['supplier.status', { status: 'exempt' }, { status: 'unknown' }, 'case.supplierStatus.status'],
    ['supplier.established', { established: false }, { established: null }, 'case.supplierStatus.established'],
    ['supplier.new_enrollment', { newEnrollment: true }, { newEnrollment: null }, 'case.supplierStatus.newEnrollment'],
    ['supplier.ownership_change', { ownershipChange: true }, { ownershipChange: null }, 'case.supplierStatus.ownershipChange'],
    ['supplier.effective_from', { effectiveFrom: '2026-02-01' }, { effectiveFrom: null }, 'case.supplierStatus.effectiveFrom'],
    ['supplier.effective_to', { effectiveTo: '2026-11-30' }, { effectiveTo: null }, 'case.supplierStatus.effectiveTo'],
  ];

  it.each(CASE_UNKNOWN)('holds no disagreement on %s when the case value is unknown', async (_field, body, status, caseField) => {
    const result = await assessed([...(await others()), await supplier('supplier-status', body)], { caseRecord: withSupplier(status) });
    expect(conditionsOf(result, 'R01')).toEqual([`R01.scope_fact_unknown|${caseField}|`]);
  });

  const UNKNOWN_VALUES: [string, Parameters<typeof supplier>[1]][] = [
    ['supplier.status', { status: 'unknown' }],
    ['supplier.established', { established: null }],
    ['supplier.new_enrollment', { newEnrollment: null }],
    ['supplier.ownership_change', { ownershipChange: null }],
    ['supplier.effective_from', { effectiveFrom: null }],
    ['supplier.effective_to', { effectiveTo: null }],
  ];

  it.each(UNKNOWN_VALUES)('holds supplier_record_value_unknown for a null or unknown %s, never a disagreement or an exempt supplier', async (field, body) => {
    const result = await assessed([...(await others()), await supplier('supplier-status', body)]);
    expect(conditionsOf(result, 'R01')).toEqual([`R01.supplier_record_value_unknown|${field}|supplier-status@1`]);
    expect(routingOf(result, 'R01')).toBe('missing/authorization_coordinator');
    expect(result.state).toBe('scope_hold');
  });

  it('holds supplier_record_not_supplied when no version has the named ID, and reads no unnamed record', async () => {
    const absent = await assessed(await others());
    expect(conditionsOf(absent, 'R01')).toEqual(['R01.supplier_record_not_supplied|-|']);
    expect(routingOf(absent, 'R01')).toBe('missing/authorization_coordinator');

    // A usable record with another document ID is neither compared nor cited by R01; R02 and R09 still classify it.
    const unnamed = await assessed([...(await others()), await supplier('supplier-other', { supplierId: 'SYN-SUP-0009', status: 'exempt' })]);
    expect(conditionsOf(unnamed, 'R01')).toEqual(['R01.supplier_record_not_supplied|-|']);
    expect(citationsOf(unnamed, 'R01')).toEqual(['order@1/item/code']);
    expect(unnamed.evidenceFacts.some((fact) => fact.documentId === 'supplier-other')).toBe(true);
  });

  it('reads no supplier record and cites none when the case names no evidence', async () => {
    const result = await assessed(await packet(), { caseRecord: withSupplier({ evidenceId: null }, { supplierStatusEvidenceId: null }) });
    expect(conditionsOf(result, 'R01')).toEqual(['R01.scope_fact_unknown|case.supplierStatusEvidenceId|']);
    expect(citationsOf(result, 'R01')).toEqual(['order@1/item/code']);
  });

  it('looks the named record up by its metadata kind, not only its document ID', async () => {
    // An order that happens to carry the named document ID is not the supplier record.
    const result = await assessed([await order('supplier-status'), await encounter(), await receipt('receipt', { orderReference: { documentId: 'supplier-status', version: 1 } })]);
    expect(conditionsOf(result, 'R01')).toEqual(['R01.supplier_record_not_supplied|-|']);
  });
});

describe('R01 named supplier evidence that cannot be verified (D4)', () => {
  const kindMismatch = () =>
    documentV2('supplier-status.v1', 'supplier-status', orderBody(), { meta: { kind: 'supplier_status', subjectId: null, sourceSystem: 'supplier_compliance' } });
  const invalidBody = () =>
    documentV2('supplier-status.v1', 'supplier-status', new TextEncoder().encode('{"not":"a body"}'), { meta: { kind: 'supplier_status', subjectId: null, sourceSystem: 'supplier_compliance' } });

  const CANDIDATES: [string, () => ReturnType<typeof supplier>, string, string, string][] = [
    ['a hash mismatch', () => supplier('supplier-status', {}, tampered()), 'manual_review/administrative_reviewer', 'R01.supplier_record_failed_provenance', 'R09.hash_mismatch'],
    ['a kind mismatch', kindMismatch, 'manual_review/administrative_reviewer', 'R01.supplier_record_failed_provenance', 'R09.kind_mismatch'],
    ['restricted access', () => supplier('supplier-status', {}, restricted()), 'restricted/authorization_coordinator', 'R01.supplier_record_restricted', 'R09.access_restricted'],
    ['declared unreadability', () => supplier('supplier-status', {}, declaredUnreadable()), 'unreadable/authorization_coordinator', 'R01.supplier_record_unreadable', 'R09.access_unreadable'],
    ['an unsupported MIME type', () => supplier('supplier-status', {}, plainText()), 'unreadable/authorization_coordinator', 'R01.supplier_record_unreadable', 'R09.mime_unsupported'],
    ['an invalid body', invalidBody, 'unreadable/authorization_coordinator', 'R01.supplier_record_unreadable', 'R09.body_invalid'],
  ];

  it.each(CANDIDATES)('reports the only named version with %s, names it and uses none of its values', async (_label, build, routing, key, r09) => {
    const result = await assessed([await order(), await encounter(), await receipt(), await build()]);
    expect(conditionsOf(result, 'R01')).toEqual([`${key}|-|supplier-status@1`]);
    expect(routingOf(result, 'R01')).toBe(routing);
    expect(parentOf(result, 'R01')).toEqual(['supplier-status@1']);
    expect(result.state).toBe('scope_hold');
    expect(conditionsOf(result, 'R09')).toEqual([`${r09}|-|supplier-status@1`]);
    expect(citationsOf(result, 'R01')).toEqual(['order@1/item/code']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'supplier-status')).toBe(false);
  });

  it.each(CANDIDATES)('reports no candidate for %s beside a current usable replacement', async (_label, build) => {
    const replacement = await supplier('supplier-status', {}, { version: 2 });
    const result = await assessed([await order(), await encounter(), await receipt(), await build(), replacement]);
    expect(conditionsOf(result, 'R01')).toEqual([]);
    expect(routingOf(result, 'R01')).toBe('pass/administrative_reviewer');
    expect(citationsOf(result, 'R01')).toEqual(sorted([...SUPPLIER_FACTS.map((fact) => fact.replace('@1', '@2')), 'order@1/item/code']));
    expect(conditionsOf(result, 'R09')).toHaveLength(1);
  });

  it('never reactivates a superseded record behind a restricted superseder', async () => {
    const result = await assessed([
      await order(),
      await encounter(),
      await receipt(),
      await supplier('supplier-status'),
      await supplier('supplier-status', {}, restricted({ version: 2, meta: { supersedes: { documentId: 'supplier-status', version: 1 } } })),
    ]);
    expect(conditionsOf(result, 'R01')).toEqual(['R01.supplier_record_restricted|-|supplier-status@2']);
    expect(result.supersededDocuments).toEqual([{ documentId: 'supplier-status', version: 1 }]);
    expect(citationsOf(result, 'R01')).toEqual(['order@1/item/code']);
  });

  it('keeps a lower-priority candidate condition below a conflict and names no parent for it', async () => {
    const result = await assessed([await order(), await encounter(), await receipt(), await supplier('supplier-status', {}, restricted())], { caseRecord: caseV2({ urgency: 'expedited' }) });
    expect(conditionsOf(result, 'R01')).toEqual(['R01.scope_fact_unsupported|case.urgency|', 'R01.supplier_record_restricted|-|supplier-status@1']);
    expect(routingOf(result, 'R01')).toBe('conflict/authorization_coordinator');
    expect(parentOf(result, 'R01')).toEqual([]);
  });
});

describe('R01 order item codes', () => {
  it('compares every current usable order, final or draft, with a stated case code', async () => {
    const result = await assessed([
      await order('order', { item: { description: 'Synthetic item', code: 'K0822', quantity: 1 } }),
      await order('order-draft', { status: 'draft', item: { description: 'Synthetic item', code: 'K0824', quantity: 1 } }),
      await order('order-same', { status: 'draft' }),
      await encounter(),
      await receipt(),
      await supplier(),
    ]);
    expect(conditionsOf(result, 'R01')).toEqual(['R01.order_item_code_disagrees|-|order-draft@1', 'R01.order_item_code_disagrees|-|order@1']);
    expect(citationsOf(result, 'R01')).toEqual(sorted([...SUPPLIER_FACTS, 'order@1/item/code', 'order-draft@1/item/code', 'order-same@1/item/code']));
  });

  it('compares no superseded order, no order without a code and nothing against an unknown case code', async () => {
    const superseded = await assessed([
      await order('order', { item: { description: 'Synthetic item', code: 'K0822', quantity: 1 } }),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }),
      await order('order-nocode', { item: { description: 'Synthetic item', code: null, quantity: 1 } }),
      await encounter(),
      await supplier(),
    ]);
    expect(conditionsOf(superseded, 'R01')).toEqual([]);

    const unknownCase = await assessed([await order('order', { item: { description: 'Synthetic item', code: 'K0822', quantity: 1 } }), await encounter(), await receipt(), await supplier()], {
      caseRecord: caseV2({ itemCode: null }),
    });
    expect(conditionsOf(unknownCase, 'R01')).toEqual(['R01.scope_fact_unknown|case.itemCode|']);
  });
});

describe('R08 policy snapshot', () => {
  it('passes for the named, reviewed, sourced pack on a supported date', async () => {
    const result = await assessed(await packet());
    expect(routingOf(result, 'R08')).toBe('pass/administrative_reviewer');
    expect(result.policyPackId).toBe(citingPackV2().packId);
    expect(result.policyPackSha256).toBe(await webCryptoSha256(bytesOf(citingPackV2())));
  });

  it('holds pack_id_differs against the actual supplied pack ID', async () => {
    const result = await assessed(await packet(), { caseRecord: caseV2({ policyPackId: 'another-pack' }) });
    expect(conditionsOf(result, 'R08')).toEqual(['R08.pack_id_differs|-|']);
    expect(routingOf(result, 'R08')).toBe('conflict/administrative_reviewer');
    expect(result.policyPackId).toBe(citingPackV2().packId);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R08: 'conflict' });
  });

  it('holds assessment_date_unsupported for a matching case and argument date the pack does not list', async () => {
    const result = await assessed(await packet(), { caseRecord: caseV2({ assessmentDate: '2026-10-19' }), assessmentDate: '2026-10-19' });
    expect(conditionsOf(result, 'R08')).toEqual(['R08.assessment_date_unsupported|-|']);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R08: 'conflict' });
  });

  it('keeps an unreviewed pack unreviewed', async () => {
    const pack = { ...citingPackV2(), reviewedAsOf: null };
    const result = await assessed(await packet(), { pack });
    expect(conditionsOf(result, 'R08')).toEqual(['R08.pack_unreviewed|-|']);
    expect(routingOf(result, 'R08')).toBe('missing/administrative_reviewer');
    expect(result.state).toBe('scope_hold');
  });

  it('holds pack_unsourced for a schema-valid all-lab pack with no source references', async () => {
    const result = await assessed(await packet(), { pack: { ...citingPackV2(), sourceRefs: [] } });
    expect(conditionsOf(result, 'R08')).toEqual(['R08.pack_unsourced|-|']);
    expect(routingOf(result, 'R08')).toBe('missing/administrative_reviewer');
  });

  it('rejects an unsourced pack with a source-based rule at schema instead', async () => {
    const pack = citingPackV2();
    pack.sourceRefs = [];
    const rule = pack.rules.find((candidate) => candidate.ruleId === 'R03');
    Object.assign(rule ?? {}, { basis: 'source', sourceSections: [{ sourceRefId: 'S01', section: 'Synthetic section' }] });
    const outcome = await assessDocuments(await packet(), { pack });
    expect(outcome).toEqual({
      schemaVersion: 'pa.assessment-outcome.v3',
      outcome: 'rejected',
      rejection: { schemaVersion: 'pa.input-rejection.v1', stage: 'schema', reasons: [{ code: 'policy_pack_invalid', documentRef: null, path: '/policyPack' }] },
    });
  });

  it('keeps every held R08 condition under the selected conflict', async () => {
    const result = await assessed(await packet(), { pack: { ...packV2(), reviewedAsOf: null }, caseRecord: caseV2({ policyPackId: 'another-pack' }) });
    expect(conditionsOf(result, 'R08')).toEqual(['R08.pack_id_differs|-|', 'R08.pack_unreviewed|-|', 'R08.pack_unsourced|-|']);
    expect(routingOf(result, 'R08')).toBe('conflict/administrative_reviewer');
    expect(parentOf(result, 'R08')).toEqual([]);
  });

  it('reads no document, so it cites nothing even when a pack lists evidence fields for it', async () => {
    const pack = citingPackV2();
    Object.assign(pack.rules.find((rule) => rule.ruleId === 'R08') ?? {}, { evidenceFields: ['order.date'] });
    const result = await assessed(await packet(), { pack });
    expect(citationsOf(result, 'R08')).toEqual([]);
  });
});
