import { EVIDENCE_FIELD_SOURCES, type EvidenceField, RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  assessDocuments,
  assessed,
  citationsOf,
  conditionsOf,
  encounter,
  note,
  order,
  packet,
  parentOf,
  READY,
  receipt,
  restricted,
  routingOf,
  statusesOf,
  supplier,
  tampered,
  TEST_EVIDENCE_FIELDS,
} from '../../test/builders-assess-v2.js';
import { bytesOf, caseV2, documentV2, orderBody, permute, SUBJECT_ID } from '../../test/builders-v2.js';

// Result-level behavior of `assessV2`: facts (C05), parents (C07), state
// precedence, finding shape and canonical array invariance.

const decoder = new TextDecoder();

describe('facts (C05)', () => {
  it('extracts every stated value of every current usable version, exactly as written', async () => {
    const result = await assessed(await packet());
    // Stated values of the default bodies: order 11 of 12 fields (no order time), encounter 10 of 14 (no completion
    // time, LCMP date or two clinical fields), receipt 5 of 5 and supplier 7 of 7.
    expect(result.evidenceFacts).toHaveLength(11 + 10 + 5 + 7);
    for (const fact of result.evidenceFacts) {
      expect(fact).toMatchObject({ schemaVersion: 'pa.evidence-fact.v2', extractionMethod: 'deterministic', confidence: null, reviewStatus: 'proposed' });
      expect(fact.locator).toBe(EVIDENCE_FIELD_SOURCES[fact.field].pointer);
    }
    expect(new Set(result.evidenceFacts.map((fact) => fact.factId)).size).toBe(result.evidenceFacts.length);
  });

  it('keeps string, number and boolean tokens as written in the source bytes', async () => {
    const text = decoder.decode(bytesOf(orderBody())).replace('"quantity": 1', '"quantity": 1e0');
    const exotic = await documentV2('order.v1', 'order', new TextEncoder().encode(text), { meta: { kind: 'order' } });
    const result = await assessed([exotic, await encounter(), await receipt(), await supplier('supplier-status', { established: true })]);
    const byField = (field: EvidenceField) => result.evidenceFacts.find((fact) => fact.field === field);
    expect([byField('order.quantity')?.value, byField('order.quantity')?.originalText]).toEqual([1, '1e0']);
    expect([byField('supplier.established')?.value, byField('supplier.established')?.originalText]).toEqual([true, 'true']);
    expect([byField('order.practitioner_name')?.value, byField('order.practitioner_name')?.originalText]).toEqual(['Casey Example, MD (synthetic)', 'Casey Example, MD (synthetic)']);
  });

  it('takes no fact from a quarantined, superseded or unusable version, nor from note titles or text', async () => {
    const result = await assessed([
      await order('order'),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }),
      await encounter(),
      await receipt('receipt', { orderReference: { documentId: 'order', version: 2 } }),
      await receipt('receipt-r', {}, restricted()),
      await receipt('receipt-t', {}, tampered()),
      await note('note-x', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }),
      await note('note'),
      await supplier(),
    ]);
    const sources = new Set(result.evidenceFacts.map((fact) => `${fact.documentId}@${String(fact.documentVersion)}`));
    expect(sources).toEqual(new Set(['order@2', 'encounter@1', 'receipt@1', 'note@1', 'supplier-status@1']));
    expect(result.evidenceFacts.filter((fact) => fact.documentId === 'note').map((fact) => fact.field)).toEqual(['note.beneficiary_name', 'note.beneficiary_identifier']);
  });

  it.each(RuleId.options)('cites for %s only facts of its own fields', async (ruleId) => {
    const result = await assessed([...(await packet()), await note('note')]);
    const facts = new Map(result.evidenceFacts.map((fact) => [fact.factId, fact]));
    const fields = new Set<string>(TEST_EVIDENCE_FIELDS[ruleId]);
    for (const factId of result.findings.find((finding) => finding.ruleId === ruleId)?.evidenceFactIds ?? []) {
      expect(fields.has(facts.get(factId)?.field ?? '')).toBe(true);
    }
  });

  it('cites nothing a pack does not list for a rule', async () => {
    const result = await assessed(await packet(), { pack: { ...(await import('../../test/builders-v2.js')).packV2(), sourceRefs: (await import('../../test/builders-assess-v2.js')).citingPackV2().sourceRefs } });
    expect(result.findings.every((finding) => finding.evidenceFactIds.length === 0)).toBe(true);
    expect(result.evidenceFacts.length).toBeGreaterThan(0);
  });

  it('cites note identity facts from R02 only', async () => {
    const result = await assessed([...(await packet()), await note('note')]);
    const citing = RuleId.options.filter((ruleId) => citationsOf(result, ruleId).some((citation) => citation.startsWith('note@1/')));
    expect(citing).toEqual(['R02']);
  });
});

describe('parents (C07)', () => {
  it('names only the selected-status candidates for R01, R03, R04 and R05, and nothing for conflicts or absences', async () => {
    const result = await assessed([
      await order('order-r', {}, restricted()),
      await order('order-u', {}, { meta: { accessStatus: 'unreadable' } }),
      await encounter('encounter', { encounterDate: '2026-09-03' }),
      await receipt('receipt-r', {}, restricted()),
      await supplier('supplier-status', {}, tampered()),
    ]);
    expect(routingOf(result, 'R01')).toBe('manual_review/administrative_reviewer');
    expect(parentOf(result, 'R01')).toEqual(['supplier-status@1']);
    expect(routingOf(result, 'R03')).toBe('restricted/authorization_coordinator');
    expect(parentOf(result, 'R03')).toEqual(['order-r@1']);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.order_restricted|-|order-r@1', 'R03.order_unreadable|-|order-u@1']);
    expect(parentOf(result, 'R04')).toEqual(['order-r@1']);
    expect(parentOf(result, 'R05')).toEqual(['receipt-r@1']);
    expect(parentOf(result, 'R06')).toEqual([]);
    expect(parentOf(result, 'R09')).toEqual(['order-r@1', 'order-u@1', 'receipt-r@1', 'supplier-status@1']);
  });

  it('gives a conflict with condition refs no parent', async () => {
    const result = await assessed([await order('order-a'), await order('order-b', { orderDate: '2026-09-04' }), await encounter(), await receipt('receipt-a', { orderReference: { documentId: 'order-a', version: 1 } }), await receipt('receipt-b', { orderReference: { documentId: 'order-b', version: 1 }, receivedAt: '2026-09-06T00:00:00Z' }), await supplier()]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.orders_disagree|order.date|order-a@1,order-b@1']);
    expect(parentOf(result, 'R03')).toEqual([]);
    expect(parentOf(result, 'R04')).toEqual([]);
  });
});

describe('state precedence', () => {
  const blocked = async () => [await order('order', { signature: null }), await encounter(), await receipt(), await supplier(), await note('note-x', { beneficiary: { name: 'Another Person', identifier: null } })];

  it('takes scope hold over human review and information needed, keeping every finding', async () => {
    const result = await assessed(await blocked(), { caseRecord: caseV2({ urgency: 'expedited' }) });
    expect(statusesOf(result)).toEqual({ ...READY, state: 'scope_hold', R01: 'conflict', R02: 'conflict', R03: 'missing' });
  });

  it('takes human review over information needed', async () => {
    expect(statusesOf(await assessed(await blocked()))).toEqual({ ...READY, state: 'needs_human_review', R02: 'conflict', R03: 'missing' });
  });

  it('takes information needed over ready', async () => {
    const result = await assessed([await order('order', { signature: null }), await encounter(), await receipt(), await supplier()]);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_information', R03: 'missing' });
  });

  it('is ready only when every effect is none', async () => {
    expect((await assessed(await packet())).state).toBe('ready_for_review');
  });
});

describe('finding shape', () => {
  it('reports one finding per rule with pack severity, case revision and a content-free explanation', async () => {
    const result = await assessed(await packet(), { caseRecord: caseV2({ revision: 4 }) });
    expect(result.findings.map((finding) => [finding.findingId, finding.severity, finding.caseRevision])).toEqual(
      RuleId.options.map((ruleId) => [`finding-${ruleId}`, ruleId === 'R06' || ruleId === 'R10' ? 'non_blocking' : 'blocking', 4]),
    );
    expect(result.caseRevision).toBe(4);
    for (const finding of result.findings) {
      expect(finding.explanation).toMatch(new RegExp(`^Test rule ${finding.ruleId} \\(${finding.status}\\): `));
      expect(finding.explanation).not.toContain('Riley');
      expect(finding.explanation).not.toContain(SUBJECT_ID);
    }
  });

  it('quotes every owning outcome and lists every held condition of a rule in its explanation', async () => {
    const result = await assessed([await order('order-a', {}, restricted()), await order('order-b', {}, tampered()), await encounter(), await receipt(), await supplier()]);
    expect(result.findings.find((finding) => finding.ruleId === 'R03')?.explanation).toBe(
      'Test rule R03 (manual_review): Synthetic manual_review outcome. Synthetic restricted outcome. Held conditions: R03.order_failed_provenance, R03.order_restricted.',
    );
  });
});

describe('canonical array invariance', () => {
  const EXAMPLES: [string, () => Promise<Awaited<ReturnType<typeof packet>>>][] = [
    [
      'mixed versions, lineage and quarantine',
      async () => [
        await order('order', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }),
        await order('order', {}, { version: 2 }),
        await order('order', {}, { version: 3, meta: { supersedes: { documentId: 'order', version: 2 } } }),
        await encounter(),
        await encounter('encounter', {}, { version: 2, meta: { supersedes: { documentId: 'encounter', version: 1 } } }),
        await receipt('receipt', { orderReference: { documentId: 'order', version: 3 } }),
        await supplier(),
        await note('note'),
      ],
    ],
    [
      'candidates of several classes',
      async () => [
        await order('order-a', {}, restricted()),
        await order('order-b', {}, tampered()),
        await encounter('encounter-a', { status: 'draft' }),
        await encounter('encounter-b', {}, restricted()),
        await receipt('receipt', {}, tampered()),
        await supplier('supplier-status', {}, { meta: { accessStatus: 'unreadable' } }),
        await supplier('supplier-other'),
      ],
    ],
    [
      'a rejected snapshot',
      async () => [await order(), { ...(await order()), slot: 'order.copy' }, await note('note', {}, { payload: null }), await encounter(), await receipt(), await supplier(), await note('note-b', {}, { version: 2, meta: { supersedes: { documentId: 'x', version: 1 } } })],
    ],
  ];

  it.each(EXAMPLES)('returns the same outcome for %s in reversed and permuted document order', async (_label, documents) => {
    const original = await documents();
    const base = await assessDocuments(original);
    expect(await assessDocuments([...original].reverse())).toEqual(base);
    expect(await assessDocuments(permute(original))).toEqual(base);
  });

  it('returns the same outcome for a schema rejection in any document order', async () => {
    const original = [
      ...(await packet()),
      await documentV2('bad-a', 'x', orderBody(), { metadataBytes: new TextEncoder().encode('[]') }),
      await documentV2('bad-b', 'y', orderBody(), { metadataBytes: bytesOf({ documentId: 'y', version: 2 }) }),
    ];
    const base = await assessDocuments(original, { caseRecord: { ...caseV2(), revision: -1 } });
    expect(base.outcome).toBe('rejected');
    expect(await assessDocuments([...original].reverse(), { caseRecord: { ...caseV2(), revision: -1 } })).toEqual(base);
    expect(await assessDocuments(permute(original), { caseRecord: { ...caseV2(), revision: -1 } })).toEqual(base);
  });
});
