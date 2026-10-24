import { type AssessmentResultV3, PolicyPackV2, type RejectionReason, RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { assessDocuments, assessed, citingPackV2, encounter, note, order, packet, receipt, restricted, supplier } from '../../test/builders-assess-v2.js';
import { bytesOf, caseV2, documentV2, editRule, inputV2, orderBody, SUBJECT_ID, SUBJECT_NAME, supplierBody, withoutKey, withoutOutcome, withoutRule } from '../../test/builders-v2.js';
import { webCryptoSha256 } from '../hash.js';
import { assessV2 } from '../index.js';
import { type AssessV2Options, type AssessV2Stage, FORCING_SEAM, type ForcingSeam, INVARIANT_VIOLATION } from './assess.js';
import { type HeldConditionsByRule, type HeldConditionV2 } from './backstop.js';
import { MAX_DOCUMENTS_V2, MAX_SOURCE_BYTES_V2 } from './input.js';

// The public rejection contract of `assessV2` (D6) and its internal
// invariant failure. Every case runs the public entry point; the
// forcing seam is reached only through its unexported options key.

const reason = (code: RejectionReason['code'], path: string | null, documentRef: RejectionReason['documentRef'] = null): RejectionReason => ({ code, documentRef, path });
const rejected = (stage: 'schema' | 'snapshot_integrity', reasons: RejectionReason[]) => ({
  schemaVersion: 'pa.assessment-outcome.v3',
  outcome: 'rejected',
  rejection: { schemaVersion: 'pa.input-rejection.v1', stage, reasons },
});
const PACK_INVALID = reason('policy_pack_invalid', '/policyPack');
const PACK_INCOMPLETE = reason('policy_pack_incomplete', '/policyPack/rules');
const BACKSTOP = rejected('schema', [PACK_INVALID]);
const encoder = new TextEncoder();

/** A schema-valid pack, asserted as such so a semantic branch is never a schema failure in disguise. */
function valid<T>(pack: T): T {
  expect(PolicyPackV2.safeParse(pack).success).toBe(true);
  return pack;
}

/** `assessV2` with the forcing seam and a trace of the stages it reached. */
async function forced(seam: ForcingSeam, documents?: Awaited<ReturnType<typeof packet>>, options: Parameters<typeof assessDocuments>[1] = {}) {
  const stages: AssessV2Stage[] = [];
  const outcome = await assessDocuments(documents ?? (await packet()), { ...options, seam: { trace: (stage) => stages.push(stage), ...seam } });
  return { outcome, stages };
}

describe('public pack check order', () => {
  const v1 = { ...citingPackV2(), schemaVersion: 'pa.policy-pack.v1' };
  const INVALID: [string, () => { pack?: unknown; packBytes?: Uint8Array }][] = [
    ['a version 1 pack', () => ({ pack: v1 })],
    ['bytes that are not JSON', () => ({ packBytes: encoder.encode('{"schemaVersion":') })],
    ['a schema-invalid pack', () => ({ pack: { ...citingPackV2(), title: '' } })],
    ['a schema-invalid pack also missing a rule', () => ({ pack: { ...withoutRule(citingPackV2(), 'R05'), title: '' } })],
  ];

  it.each(INVALID)('rejects %s as policy_pack_invalid at /policyPack', async (_label, options) => {
    expect(await assessDocuments(await packet(), options())).toEqual(rejected('schema', [PACK_INVALID]));
  });

  it('rejects a schema-valid pack missing a rule as incomplete, even when a surviving rule lacks a key and an outcome', async () => {
    expect(await assessDocuments(await packet(), { pack: valid(withoutRule(citingPackV2(), 'R07')) })).toEqual(rejected('schema', [PACK_INCOMPLETE]));
    const worse = withoutOutcome(withoutKey(withoutRule(citingPackV2(), 'R07'), 'R03.element_missing'), 'R05', 'pass');
    expect(await assessDocuments(await packet(), { pack: valid(worse) })).toEqual(rejected('schema', [PACK_INCOMPLETE]));
  });

  const COVERAGE: [string, () => PolicyPackV2][] = [
    ['a missing key', () => withoutKey(citingPackV2(), 'R04.order_not_final')],
    ['a missing supported non-pass outcome', () => withoutOutcome(citingPackV2(), 'R03', 'restricted')],
    ['a missing supported pass outcome', () => withoutOutcome(citingPackV2(), 'R07', 'pass')],
    ['several missing keys and outcomes', () => withoutOutcome(withoutKey(withoutKey(citingPackV2(), 'R01.supplier_id_disagrees'), 'R09.body_invalid'), 'R08', 'pass')],
    ['an incompatible qualifier', () => editRule(citingPackV2(), 'R03', (rule) => Object.assign(rule.outcomes[4]?.conditions[1] ?? {}, { qualifier: 'evidence_field', fields: ['order.date'] }))],
    ['a missing emitted field', () => editRule(citingPackV2(), 'R03', (rule) => Object.assign(rule.outcomes[4]?.conditions[1] ?? {}, { fields: ['element.beneficiary', 'element.order_date'] }))],
    ['an incompatible arity', () => editRule(citingPackV2(), 'R04', (rule) => Object.assign(rule.outcomes[0]?.conditions[0] ?? {}, { documentArity: 'one' }))],
    ['a missing emitted kind', () => editRule(citingPackV2(), 'R09', (rule) => Object.assign(rule.outcomes[0]?.conditions[0] ?? {}, { documentKinds: ['order'] }))],
    ['R06 routed to an administrative role', () => editRule(citingPackV2(), 'R06', (rule) => Object.assign(rule.outcomes[0] ?? {}, { responsibleRole: 'administrative_reviewer' }))],
    ['R06 made a readiness blocker', () => editRule(citingPackV2(), 'R06', (rule) => Object.assign(rule.outcomes[0] ?? {}, { stateEffect: 'needs_human_review' }))],
    ['R10 given a state effect', () => editRule(citingPackV2(), 'R10', (rule) => Object.assign(rule.outcomes[0] ?? {}, { stateEffect: 'needs_information' }))],
  ];

  it.each(COVERAGE)('rejects a schema-valid ten-rule pack with %s as one policy_pack_invalid', async (_label, build) => {
    expect(await assessDocuments(await packet(), { pack: valid(build()) })).toEqual(rejected('schema', [PACK_INVALID]));
  });

  it('allows extra unreachable declarations and fields', async () => {
    const pack = citingPackV2();
    // The test pack already declares `R09.locator_unresolved` and R03 disagreement on beneficiary fields; add another unreachable key.
    const extended = editRule(pack, 'R05', (rule) =>
      rule.outcomes[0]?.conditions.push({ conditionKey: 'R05.extra_unreachable', qualifier: 'none', fields: [], documentArity: 'none', documentKinds: [], statement: 'Synthetic extra declaration.' }),
    );
    expect((await assessDocuments(await packet(), { pack: valid(extended) })).outcome).toBe('assessed');
  });
});

describe('public schema-stage reason sets', () => {
  const badSidecars = async () => {
    // One sidecar whose ID and version parse (identity reported) and one that is not JSON (no identity).
    const identified = await documentV2('bad-a', 'note-a', orderBody(), { metadataBytes: bytesOf({ schemaVersion: 'pa.document.v1', documentId: 'note-a', version: 3, kind: 'order' }) });
    const opaque = await documentV2('bad-b', 'note-b', orderBody(), { metadataBytes: encoder.encode('not json') });
    return [identified, opaque];
  };
  const SIDECARS = [reason('document_metadata_invalid', '/documents/bad-b/metadata'), reason('document_metadata_invalid', '/documents/bad-a/metadata', { documentId: 'note-a', version: 3 })];
  const BRANCHES: [string, { pack?: unknown; packBytes?: Uint8Array }, RejectionReason][] = [
    ['an invalid pack', { pack: { ...citingPackV2(), schemaVersion: 'pa.policy-pack.v1' } }, PACK_INVALID],
    ['an incomplete pack', { pack: withoutRule(citingPackV2(), 'R02') }, PACK_INCOMPLETE],
    ['an uncovering pack', { pack: withoutKey(citingPackV2(), 'R05.no_usable_order') }, PACK_INVALID],
  ];

  it.each(BRANCHES)('reports %s with an invalid case, two invalid sidecars and an invalid date, as the complete canonical set', async (_label, pack, packReason) => {
    const outcome = await assessDocuments([...(await packet()), ...(await badSidecars())], { ...pack, caseRecord: caseV2({ subjectName: ` ${SUBJECT_NAME}` }), assessmentDate: '2026-02-30' });
    expect(outcome).toEqual(rejected('schema', [reason('assessment_date_invalid', '/assessmentDate'), reason('case_invalid', '/case'), ...SIDECARS, packReason]));
  });

  it.each(BRANCHES)('reports %s with only an invalid case', async (_label, pack, packReason) => {
    const outcome = await assessDocuments(await packet(), { ...pack, caseRecord: { ...caseV2(), revision: 0 } });
    expect(outcome).toEqual(rejected('schema', [reason('case_invalid', '/case'), packReason]));
  });

  it.each(BRANCHES)('reports %s with valid differing dates and invalid metadata, including the mismatch', async (_label, pack, packReason) => {
    const outcome = await assessDocuments([...(await packet()), ...(await badSidecars())], { ...pack, assessmentDate: '2026-10-19' });
    expect(outcome).toEqual(rejected('schema', [reason('assessment_date_mismatch', '/assessmentDate'), ...SIDECARS, packReason]));
  });

  it('suppresses the mismatch when the case is invalid, even though its written date differs', async () => {
    const outcome = await assessDocuments(await packet(), { caseRecord: caseV2({ subjectName: `${SUBJECT_NAME} `, assessmentDate: '2026-10-17' }) });
    expect(outcome).toEqual(rejected('schema', [reason('case_invalid', '/case')]));
  });

  it('rejects a padded case value on raw bytes and after an exact parse and serialization', async () => {
    const padded = caseV2({ subjectId: ` ${SUBJECT_ID}` });
    const raw = encoder.encode(`{\n  ${JSON.stringify(padded).slice(1, -1)}\n}`);
    expect(await assessDocuments(await packet(), { caseBytes: raw })).toEqual(rejected('schema', [reason('case_invalid', '/case')]));
    expect(await assessDocuments(await packet(), { caseBytes: encoder.encode(JSON.stringify(JSON.parse(new TextDecoder().decode(raw)))) })).toEqual(rejected('schema', [reason('case_invalid', '/case')]));
    // The same unpadded case parses from either formatting.
    const formatted = encoder.encode(JSON.stringify(caseV2(), null, 2));
    expect((await assessDocuments(await packet(), { caseBytes: formatted })).outcome).toBe('assessed');
  });

  it('treats an unparseable body as R09, never a rejection', async () => {
    const broken = await documentV2('note.v1', 'note', encoder.encode('{'), { meta: { kind: 'supporting_note' } });
    const result = await assessed([...(await packet()), broken]);
    expect(result.findings.find((finding) => finding.ruleId === 'R09')?.conditions.map((condition) => condition.conditionKey)).toEqual(['R09.body_invalid']);
  });
});

describe('public snapshot-integrity reason sets', () => {
  it('reports a duplicate for every sharing slot, still checks byte presence and skips supersession', async () => {
    const outcome = await assessDocuments([
      await order(),
      { ...(await order()), slot: 'order.copy' },
      await note('note', {}, { payload: null }),
      await note('note-r', {}, restricted({ payload: encoder.encode('{}') })),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'other', version: 1 } } }),
      await encounter(),
      await receipt(),
      await supplier(),
    ]);
    expect(outcome).toEqual(
      rejected('snapshot_integrity', [
        reason('document_bytes_missing', '/documents/note.v1/payload', { documentId: 'note', version: 1 }),
        reason('duplicate_document_version', '/documents/order.copy/metadata', { documentId: 'order', version: 1 }),
        reason('duplicate_document_version', '/documents/order.v1/metadata', { documentId: 'order', version: 1 }),
        reason('restricted_document_has_bytes', '/documents/note-r.v1/payload', { documentId: 'note-r', version: 1 }),
      ]),
    );
  });

  it('reports every cross-document, cross-kind and cross-subject reason together', async () => {
    const outcome = await assessDocuments([
      await order(),
      await encounter(),
      await receipt(),
      await supplier(),
      await note('note'),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'encounter', version: 1 } } }),
      await documentV2('note.v2', 'note', orderBody(), { version: 2, meta: { kind: 'order', supersedes: { documentId: 'note', version: 1 } } }),
      await encounter('encounter', {}, { version: 2, meta: { subjectId: 'SYN-BEN-T99', supersedes: { documentId: 'encounter', version: 1 } } }),
    ]);
    expect(outcome).toEqual(
      rejected('snapshot_integrity', [
        reason('supersession_cross_document', '/documents/order.v2/metadata/supersedes', { documentId: 'order', version: 2 }),
        reason('supersession_cross_kind', '/documents/note.v2/metadata/supersedes', { documentId: 'note', version: 2 }),
        reason('supersession_cross_kind', '/documents/order.v2/metadata/supersedes', { documentId: 'order', version: 2 }),
        reason('supersession_cross_subject', '/documents/encounter.v2/metadata/supersedes', { documentId: 'encounter', version: 2 }),
      ]),
    );
  });

  it('rejects an absent cross-document target but ignores an absent earlier same-ID target', async () => {
    const cross = await assessDocuments([...(await packet()), await note('note', {}, { version: 2, meta: { supersedes: { documentId: 'missing', version: 1 } } })]);
    expect(cross).toEqual(rejected('snapshot_integrity', [reason('supersession_cross_document', '/documents/note.v2/metadata/supersedes', { documentId: 'note', version: 2 })]));
    const same = await assessed([...(await packet()), await note('note', {}, { version: 2, meta: { supersedes: { documentId: 'note', version: 1 } } })]);
    expect(same.supersededDocuments).toEqual([]);
  });

  it('accepts subjectless supplier lineage', async () => {
    const result = await assessed([
      await order(),
      await encounter(),
      await receipt(),
      await supplier(),
      await documentV2('supplier-status.v2', 'supplier-status', supplierBody(), { version: 2, meta: { supersedes: { documentId: 'supplier-status', version: 1 } } }),
    ]);
    expect(result.supersededDocuments).toEqual([{ documentId: 'supplier-status', version: 1 }]);
  });
});

describe('earlier stages run before evaluation, and are never replaced by the backstop', () => {
  const everythingForced: ForcingSeam = { evaluate: () => ({}) as HeldConditionsByRule };

  it('returns only the schema set for a pack coverage defect beside a snapshot defect, never reaching snapshot processing', async () => {
    const { outcome, stages } = await forced(everythingForced, [...(await packet()), { ...(await order()), slot: 'order.copy' }], { pack: withoutKey(citingPackV2(), 'R03.no_usable_order') });
    expect(outcome).toEqual(rejected('schema', [PACK_INVALID]));
    expect(stages).toEqual(['schema']);
  });

  it('returns an ordinary snapshot rejection before evaluation and the backstop', async () => {
    const { outcome, stages } = await forced(everythingForced, [...(await packet()), { ...(await order()), slot: 'order.copy' }]);
    expect(outcome).toMatchObject({ outcome: 'rejected', rejection: { stage: 'snapshot_integrity' } });
    expect(stages).toEqual(['schema', 'snapshot_integrity']);
  });

  it('keeps a schema reason set when the evaluator would be forced unrepresentable', async () => {
    const { outcome, stages } = await forced(everythingForced, await packet(), { caseRecord: { ...caseV2(), synthetic: false } });
    expect(outcome).toEqual(rejected('schema', [reason('case_invalid', '/case')]));
    expect(stages).toEqual(['schema']);
  });

  it('runs every stage in order for a valid input', async () => {
    const { outcome, stages } = await forced({});
    expect(outcome.outcome).toBe('assessed');
    expect(stages).toEqual(['schema', 'snapshot_integrity', 'classification', 'evaluation', 'backstop', 'assembly', 'validation']);
  });
});

describe('representability backstop through assessV2', () => {
  const orderDoc = { ref: { documentId: 'order', version: 1 }, kind: 'order' as const };
  const encounterDoc = { ref: { documentId: 'encounter', version: 1 }, kind: 'encounter' as const };
  const adding =
    (ruleId: RuleId, conditions: HeldConditionV2[]): ForcingSeam['evaluate'] =>
    (_snapshot, held) => ({ ...held, [ruleId]: [...held[ruleId], ...conditions] });
  const replacing =
    (ruleId: RuleId, conditions: HeldConditionV2[]): ForcingSeam['evaluate'] =>
    (_snapshot, held) => ({ ...held, [ruleId]: conditions });

  const FORCED: [string, ForcingSeam['evaluate']][] = [
    ['an undeclared status', adding('R02', [{ status: 'missing', conditionKey: 'R02.document_quarantined', field: 'binding.stated_name', documents: [orderDoc] }])],
    ['a status the rule never selects', adding('R07', [{ status: 'conflict', conditionKey: 'R07.lcmp_stated_by_case', field: null, documents: [] }])],
    ['an undeclared key', adding('R03', [{ status: 'missing', conditionKey: 'R03.invented_condition', field: null, documents: [] }])],
    ['a declared key the evaluator does not support', adding('R09', [{ status: 'conflict', conditionKey: 'R09.locator_unresolved', field: null, documents: [orderDoc] }])],
    ['an unselectable R06', replacing('R06', [])],
    ['an unselectable R10', replacing('R10', [])],
    ['a wrong qualifier field', adding('R03', [{ status: 'missing', conditionKey: 'R03.element_missing', field: 'order.date', documents: [orderDoc] }])],
    ['a field the declaration omits', adding('R01', [{ status: 'conflict', conditionKey: 'R01.scope_fact_unsupported', field: 'case.lcmpIncorporated', documents: [] }])],
    ['a wrong arity', adding('R04', [{ status: 'conflict', conditionKey: 'R04.order_before_encounter', field: null, documents: [orderDoc] }])],
    ['a wrong kind', adding('R03', [{ status: 'restricted', conditionKey: 'R03.order_restricted', field: null, documents: [encounterDoc] }])],
  ];

  it.each(FORCED)('returns exactly the content-free backstop for %s after a successful preflight, without throwing', async (_label, evaluate) => {
    const { outcome, stages } = await forced({ evaluate });
    expect(outcome).toEqual(BACKSTOP);
    expect(stages).toEqual(['schema', 'snapshot_integrity', 'classification', 'evaluation', 'backstop']);
    expect(JSON.stringify(outcome)).not.toMatch(/R0|R10|state|finding|fact|order|Riley/);
  });

  it('returns the backstop when the pack routes a fixed rule differently, through the schema check before evaluation', async () => {
    const rerouted = editRule(citingPackV2(), 'R06', (rule) => Object.assign(rule.outcomes[0] ?? {}, { responsibleRole: 'authorization_coordinator' }));
    const { outcome, stages } = await forced({}, await packet(), { pack: valid(rerouted) });
    expect(outcome).toEqual(BACKSTOP);
    expect(stages).toEqual(['schema']);
  });
});

describe('internal invariant violations', () => {
  const FORBIDDEN = [SUBJECT_ID, SUBJECT_NAME, 'order', 'encounter', 'receipt', 'supplier', 'case-v2-t01', 'test-pack', '/documents', '/case', 'R0', 'K0823', '2026'];

  async function invariantError(seam: ForcingSeam, documents?: Awaited<ReturnType<typeof packet>>) {
    const error: unknown = await assessDocuments(documents ?? (await packet()), { seam }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    const thrown = error as Error;
    expect(Object.getPrototypeOf(thrown)).toBe(Error.prototype);
    expect(thrown.message).toBe(INVARIANT_VIOLATION);
    expect(Object.keys(thrown)).toEqual([]);
    expect(thrown.cause).toBeUndefined();
    for (const content of FORBIDDEN) {
      expect(thrown.message).not.toContain(content);
    }
    return thrown;
  }

  it('throws a content-free Error for a duplicate condition identity that representability accepts', async () => {
    const duplicate: HeldConditionV2 = { status: 'missing', conditionKey: 'R03.element_missing', field: 'element.signature', documents: [{ ref: { documentId: 'order', version: 1 }, kind: 'order' }] };
    await invariantError({ evaluate: (_snapshot, held) => ({ ...held, R03: [duplicate, duplicate] }) });
  });

  it('throws a content-free Error for a condition naming a version the snapshot lacks', async () => {
    const dangling: HeldConditionV2 = { status: 'missing', conditionKey: 'R05.order_receipt_missing', field: null, documents: [{ ref: { documentId: 'order', version: 9 }, kind: 'order' }] };
    await invariantError({ evaluate: (_snapshot, held) => ({ ...held, R05: [dangling] }) });
  });

  it('throws a content-free Error for a dangling fact ID', async () => {
    await invariantError({ tamper: (result) => withFinding(result, 'R03', (finding) => ({ ...finding, evidenceFactIds: [...finding.evidenceFactIds, 'fact-9999'] })) });
  });

  it('accepts an unchanged result through the same seam', async () => {
    const outcome = await assessDocuments(await packet(), { seam: { tamper: (result) => result } });
    expect(outcome.outcome).toBe('assessed');
  });
});

/** A result with one finding replaced. */
function withFinding(result: AssessmentResultV3, ruleId: RuleId, edit: (finding: AssessmentResultV3['findings'][number]) => unknown): AssessmentResultV3 {
  return { ...result, findings: result.findings.map((finding) => (finding.ruleId === ruleId ? edit(finding) : finding)) } as AssessmentResultV3;
}

const withFact = (result: AssessmentResultV3, field: string, edit: (fact: AssessmentResultV3['evidenceFacts'][number]) => unknown) =>
  ({ ...result, evidenceFacts: result.evidenceFacts.map((fact) => (fact.field === field ? edit(fact) : fact)) }) as AssessmentResultV3;

describe('final result validation rejects every tampered invariant', () => {
  const quarantined = async () => [...(await packet()), await note('note-x', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } })];
  const candidates = async () => [await order('order-a', {}, restricted()), await order('order-b', {}, { payload: encoder.encode('{}') }), await encounter(), await receipt(), await supplier()];
  const drafts = async () => [...(await packet()), await encounter('encounter-draft', { status: 'draft' })];
  const unsigned = async () => [await order('order', { signature: null }), await encounter(), await receipt(), await supplier()];
  // A quantity written as 1.0: the schema accepts the token 1 for the value too, so only the exact-source check sees a drift.
  const tokenPacket = async () => [
    await documentV2('order.v1', 'order', encoder.encode(new TextDecoder().decode(bytesOf(orderBody())).replace('"quantity": 1', '"quantity": 1.0')), { meta: { kind: 'order' } }),
    await encounter(),
    await receipt(),
    await supplier(),
  ];
  // No rule cites encounter.practitioner_name, so only the fact check judges a fact moved to the superseded version.
  const lineage = async () => [await order(), await encounter(), await encounter('encounter', {}, { version: 2, meta: { supersedes: { documentId: 'encounter', version: 1 } } }), await receipt(), await supplier()];

  const TAMPERS: [string, () => Promise<Awaited<ReturnType<typeof packet>>>, (result: AssessmentResultV3) => unknown][] = [
    ['a state weakened to ready on a blocked case', quarantined, (result) => ({ ...result, state: 'ready_for_review' })],
    ['a state raised on a ready case', packet, (result) => ({ ...result, state: 'needs_information' })],
    ['another finding status', packet, (result) => withFinding(result, 'R07', (finding) => ({ ...finding, status: 'manual_review' }))],
    ['R06 routed away from qualified review', packet, (result) => withFinding(result, 'R06', (finding) => ({ ...finding, responsibleRole: 'administrative_reviewer' }))],
    ['another severity', packet, (result) => withFinding(result, 'R10', (finding) => ({ ...finding, severity: 'blocking' }))],
    ['a lost lower-priority condition', candidates, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, conditions: finding.conditions.slice(0, 1) }))],
    ['a duplicated condition', candidates, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, conditions: [finding.conditions[0], ...finding.conditions] }))],
    ['a condition under another field', packet, (result) => withFinding(result, 'R06', (finding) => ({ ...finding, conditions: [{ conditionKey: 'R06.clinical_review', field: 'order.date', documentRefs: [] }] }))],
    ['a condition naming the wrong kind', candidates, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, conditions: finding.conditions.map((condition) => ({ ...condition, documentRefs: [{ documentId: 'encounter', version: 1 }] })) }))],
    ['a missing parent', candidates, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, documentRefs: [] }))],
    ['an extra parent', packet, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, documentRefs: [{ documentId: 'order', version: 1 }] }))],
    ['a wrong R02 parent', quarantined, (result) => withFinding(result, 'R02', (finding) => ({ ...finding, documentRefs: [{ documentId: 'note', version: 1 }] }))],
    ['a removed citation', packet, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, evidenceFactIds: finding.evidenceFactIds.slice(1) }))],
    [
      'a draft fact cited by R04',
      drafts,
      (result) =>
        withFinding(result, 'R04', (finding) => ({
          ...finding,
          evidenceFactIds: [...finding.evidenceFactIds, ...result.evidenceFacts.filter((fact) => fact.documentId === 'encounter-draft' && fact.field === 'encounter.date').map((fact) => fact.factId)],
        })),
    ],
    ['a citation outside the rule fields', packet, (result) => withFinding(result, 'R07', (finding) => ({ ...finding, evidenceFactIds: [result.evidenceFacts[0]?.factId] }))],
    ['drifted original text', packet, (result) => withFact(result, 'order.item_description', (fact) => ({ ...fact, originalText: `${String(fact.originalText)} ` }))],
    ['a drifted value with matching text', packet, (result) => withFact(result, 'order.item_description', (fact) => ({ ...fact, value: 'Other text', originalText: 'Other text' }))],
    ['a fact under another field of the same kind', packet, (result) => withFact(result, 'order.signature_date', (fact) => ({ ...fact, field: 'order.date', locator: '/orderDate' }))],
    ['a fact moved to another version', packet, (result) => withFact(result, 'order.quantity', (fact) => ({ ...fact, documentVersion: 2 }))],
    [
      'a fact from a quarantined version',
      quarantined,
      (result) => ({
        ...result,
        evidenceFacts: [...result.evidenceFacts, { ...result.evidenceFacts.find((fact) => fact.field === 'order.beneficiary_identifier'), factId: 'fact-0999', documentId: 'note-x', field: 'note.beneficiary_identifier' }],
      }),
    ],
    ['a drifted number token that still matches its value', tokenPacket, (result) => withFact(result, 'order.quantity', (fact) => ({ ...fact, originalText: '1' }))],
    ['a usable condition naming a document of an undeclared kind', unsigned, (result) => withFinding(result, 'R03', (finding) => ({ ...finding, conditions: finding.conditions.map((condition) => ({ ...condition, documentRefs: [{ documentId: 'encounter', version: 1 }] })) }))],
    ['a fact from a superseded version', lineage, (result) => withFact(result, 'encounter.practitioner_name', (fact) => ({ ...fact, documentVersion: 1 }))],
    ['a fact with confidence', packet, (result) => withFact(result, 'order.quantity', (fact) => ({ ...fact, extractionMethod: 'model', confidence: 1 }))],
    ['an accepted fact', packet, (result) => withFact(result, 'order.quantity', (fact) => ({ ...fact, reviewStatus: 'accepted' }))],
    ['a missing fact', packet, (result) => ({ ...result, evidenceFacts: result.evidenceFacts.slice(1), findings: result.findings.map((finding) => ({ ...finding, evidenceFactIds: finding.evidenceFactIds.filter((id) => id !== result.evidenceFacts[0]?.factId) })) })],
    ['a renamed finding', packet, (result) => withFinding(result, 'R05', (finding) => ({ ...finding, findingId: 'finding-other' }))],
    ['a changed explanation', packet, (result) => withFinding(result, 'R05', (finding) => ({ ...finding, explanation: `${String(finding.explanation)} Riley Testcase.` }))],
    ['a missing finding', packet, (result) => ({ ...result, findings: result.findings.filter((finding) => finding.ruleId !== 'R10') })],
    ['an emptied quarantine list', quarantined, (result) => ({ ...result, quarantinedDocuments: [] })],
    ['an invented superseded version', packet, (result) => ({ ...result, supersededDocuments: [{ documentId: 'order', version: 1 }] })],
    ['another pack hash', packet, (result) => ({ ...result, policyPackSha256: '0'.repeat(64) })],
    ['another pack ID', packet, (result) => ({ ...result, policyPackId: 'another-pack' })],
    ['another case revision', packet, (result) => ({ ...result, caseRevision: 2, findings: result.findings.map((finding) => ({ ...finding, caseRevision: 2 })) })],
    ['an extra property', packet, (result) => ({ ...result, approved: true })],
  ];

  it.each(TAMPERS)('throws the invariant Error for %s', async (_label, documents, tamper) => {
    const error: unknown = await assessDocuments(await documents(), { seam: { tamper } }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(INVARIANT_VIOLATION);
  });

  it.each([...new Set(TAMPERS.map(([, documents]) => documents))].map((documents, index) => [index, documents] as const))('assesses input set %i unchanged without the tamper', async (_index, documents) => {
    expect((await assessDocuments(await documents())).outcome).toBe('assessed');
  });
});

describe('adapter contract violations are thrown caller defects', () => {
  it('throws a RangeError for more than the document limit, before parsing', async () => {
    const one = await order();
    const documents = Array.from({ length: MAX_DOCUMENTS_V2 + 1 }, (_, index) => ({ ...one, slot: `slot-${String(index)}` }));
    await expect(assessV2(inputV2(documents, { caseBytes: encoder.encode('not json') }))).rejects.toThrow(RangeError);
  });

  it('throws a RangeError for an oversized payload', async () => {
    const big = { ...(await order()), payload: new Uint8Array(MAX_SOURCE_BYTES_V2 + 1) };
    await expect(assessV2(inputV2([big]))).rejects.toThrow(RangeError);
  });

  it.each([
    ['a duplicate slot', 'order.v1'],
    ['an unsafe slot', '../order'],
  ])('throws a TypeError for %s', async (_label, slot) => {
    const documents = [await order(), { ...(await encounter()), slot }];
    await expect(assessV2(inputV2(documents))).rejects.toThrow(TypeError);
  });

  it('assesses private copies, so a caller changing its bytes during the call changes nothing', async () => {
    const baseline = await assessV2(inputV2(await packet(), { pack: citingPackV2() }));
    const input = inputV2(await packet(), { pack: citingPackV2() });
    let changed = false;
    // The hasher runs mid-call; it rewrites every caller-held byte once, before the first hash.
    const sha256 = async (bytes: Uint8Array) => {
      if (!changed) {
        changed = true;
        for (const document of input.documents) {
          document.payload?.fill(32);
          document.metadata.fill(32);
        }
        input.policyPackBytes.fill(32);
        input.caseBytes.fill(32);
      }
      return webCryptoSha256(bytes);
    };
    expect(await assessV2(input, { sha256 })).toEqual(baseline);
    expect(changed).toBe(true);
  });
});

describe('public surface', () => {
  it('exports assessV2 but no internal stage, evaluator, validator or forcing seam', async () => {
    const domain = await import('../index.js');
    const exported = Object.keys(domain);
    expect(exported).toContain('assessV2');
    for (const internal of ['FORCING_SEAM', 'INVARIANT_VIOLATION', 'evaluateRulesV2', 'assembleResultV3', 'resultIssuesV3', 'documentsRead', 'receiptSequence', 'factsOf', 'parentRefs', 'evaluateWithBackstop', 'preflightV2']) {
      expect(exported).not.toContain(internal);
    }
    const options: AssessV2Options = {};
    expect(Object.getOwnPropertySymbols(options)).toEqual([]);
    expect(Object.values(domain)).not.toContain(FORCING_SEAM);
  });

  it('ignores a look-alike seam key', async () => {
    const lookalike = { [Symbol('pa.domain.assessV2.forcingSeam')]: { tamper: () => ({}) }, ['pa.domain.assessV2.forcingSeam']: { tamper: () => ({}) } } as AssessV2Options;
    const outcome = await assessV2(inputV2(await packet(), { pack: citingPackV2() }), lookalike);
    expect(outcome.outcome).toBe('assessed');
  });

  it('keeps every rule in the inventory order', async () => {
    const result = await assessed(await packet());
    expect(result.findings.map((finding) => finding.ruleId)).toEqual(RuleId.options);
  });
});
