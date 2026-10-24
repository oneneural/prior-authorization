import { AssessmentOutcomeV3, RuleId } from '@pa/contracts';
import { describe, expect, it, vi } from 'vitest';

import { caseV2, documentV2, editRule, inputV2, orderBody, packV2, supportedDocumentsV2, withoutKey } from '../../test/builders-v2.js';
import * as domain from '../index.js';
import { type HeldConditionsByRule, type HeldConditionV2, selectRepresentable } from './backstop.js';
import { evaluateWithBackstop, type PreflightSnapshot, type PreflightStage } from './preflight.js';

const BACKSTOP = {
  schemaVersion: 'pa.assessment-outcome.v3',
  outcome: 'rejected',
  rejection: { schemaVersion: 'pa.input-rejection.v1', stage: 'schema', reasons: [{ code: 'policy_pack_invalid', documentRef: null, path: '/policyPack' }] },
};

const order = { ref: { documentId: 'order', version: 1 }, kind: 'order' as const };
const encounter = { ref: { documentId: 'encounter', version: 1 }, kind: 'encounter' as const };

/** The minimal representable evaluation: R06 and R10 hold their fixed conditions and every other rule passes. */
function baseline(): Record<RuleId, HeldConditionV2[]> {
  const held = Object.fromEntries(RuleId.options.map((ruleId) => [ruleId, []])) as unknown as Record<RuleId, HeldConditionV2[]>;
  held.R06 = [{ status: 'manual_review', conditionKey: 'R06.clinical_review', field: null, documents: [] }];
  held.R10 = [{ status: 'not_applicable', conditionKey: 'R10.pure_assessment', field: null, documents: [] }];
  return held;
}

const forcing = (ruleId: RuleId, conditions: HeldConditionV2[]) => (): HeldConditionsByRule => ({ ...baseline(), [ruleId]: conditions });

describe('backstop after a successful preflight (D6 clarification)', () => {
  it('selects the first pack outcome owning a held condition, or pass, when everything is representable', async () => {
    const held = {
      ...baseline(),
      R03: [
        { status: 'missing', conditionKey: 'R03.element_missing', field: 'element.signature', documents: [order] },
        { status: 'restricted', conditionKey: 'R03.order_restricted', field: null, documents: [order] },
      ],
    } satisfies HeldConditionsByRule;
    const result = await evaluateWithBackstop(inputV2(await supportedDocumentsV2()), () => held);
    if (result.outcome !== 'representable') {
      throw new Error('expected a representable evaluation');
    }
    expect(result.selections.R03.status).toBe('restricted');
    expect(result.selections.R01.status).toBe('pass');
    expect(result.selections.R06).toMatchObject({ status: 'manual_review', responsibleRole: 'qualified_clinical_reviewer', stateEffect: 'none' });
    expect(result.selections.R10.status).toBe('not_applicable');
  });

  const FORCED: [string, () => HeldConditionsByRule][] = [
    ['an undeclared status', forcing('R02', [{ status: 'missing', conditionKey: 'R02.document_quarantined', field: 'binding.stated_name', documents: [order] }])],
    ['a status the rule never selects', forcing('R07', [{ status: 'conflict', conditionKey: 'R07.lcmp_stated_by_case', field: null, documents: [] }])],
    ['an undeclared key', forcing('R03', [{ status: 'missing', conditionKey: 'R03.invented_condition', field: null, documents: [] }])],
    ['a declared key the evaluator does not support', forcing('R09', [{ status: 'conflict', conditionKey: 'R09.locator_unresolved', field: null, documents: [order] }])],
    ['a key under another status', forcing('R05', [{ status: 'missing', conditionKey: 'R05.receipt_unsequenced', field: null, documents: [order, order] }])],
    ['a pass condition', forcing('R08', [{ status: 'pass', conditionKey: 'R08.pack_unreviewed', field: null, documents: [] }])],
    ['an unselectable outcome', () => ({ ...baseline(), R06: [] })],
    ['an unselectable fixed outcome', () => ({ ...baseline(), R10: [] })],
    ['a field outside the qualifier', forcing('R03', [{ status: 'missing', conditionKey: 'R03.element_missing', field: 'order.date', documents: [order] }])],
    ['a field of the right kind that the declaration omits', forcing('R01', [{ status: 'conflict', conditionKey: 'R01.scope_fact_unsupported', field: 'case.lcmpIncorporated', documents: [] }])],
    ['a null field for a qualified key', forcing('R03', [{ status: 'missing', conditionKey: 'R03.element_missing', field: null, documents: [order] }])],
    ['a field for an unqualified key', forcing('R03', [{ status: 'restricted', conditionKey: 'R03.order_restricted', field: 'element.signature', documents: [order] }])],
    ['an incompatible arity', forcing('R04', [{ status: 'conflict', conditionKey: 'R04.order_before_encounter', field: null, documents: [order] }])],
    ['an incompatible document kind', forcing('R03', [{ status: 'restricted', conditionKey: 'R03.order_restricted', field: null, documents: [encounter] }])],
    ['duplicate document references', forcing('R03', [{ status: 'conflict', conditionKey: 'R03.orders_disagree', field: 'order.date', documents: [order, order] }])],
  ];

  it.each(FORCED)('returns the exact content-free backstop for %s, with no state, facts or findings', async (_label, evaluate) => {
    const result = await evaluateWithBackstop(inputV2(await supportedDocumentsV2()), evaluate);
    expect(result).toEqual(BACKSTOP);
    expect(AssessmentOutcomeV3.safeParse(result).success).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/R0|R10|state|finding|fact/);
  });

  it('selects nothing when the pack routes a fixed outcome differently from the inventory', () => {
    expect(selectRepresentable(packV2(), baseline())).toBeDefined();
    const rerouted = editRule(packV2(), 'R06', (rule) => Object.assign(rule.outcomes[0] ?? {}, { stateEffect: 'needs_human_review' }));
    expect(selectRepresentable(rerouted, baseline())).toBeUndefined();
  });

  it('never runs the evaluator or the backstop when a schema or snapshot rejection applies', async () => {
    const evaluate = vi.fn(forcing('R06', []));
    const stages: PreflightStage[] = [];
    const trace = (stage: PreflightStage) => stages.push(stage);
    const documents = await supportedDocumentsV2();

    const schema = await evaluateWithBackstop(inputV2(documents, { caseRecord: caseV2({ subjectName: ' padded' }), pack: withoutKey(packV2(), 'R04.order_not_final') }), evaluate, { trace });
    expect(schema).toMatchObject({ outcome: 'rejected', rejection: { stage: 'schema' } });
    expect(schema.outcome === 'rejected' && schema.rejection.reasons.map((reason) => reason.code)).toEqual(['case_invalid', 'policy_pack_invalid']);

    const duplicate = { ...(await documentV2('order.v1', 'order', orderBody())), slot: 'order.v1.dup1' };
    const integrity = await evaluateWithBackstop(inputV2([...documents, duplicate]), evaluate, { trace });
    expect(integrity).toMatchObject({ outcome: 'rejected', rejection: { stage: 'snapshot_integrity' } });

    expect(evaluate).not.toHaveBeenCalled();
    expect(stages).toEqual(['schema', 'schema', 'snapshot_integrity']);
  });

  it('runs the stages in order for a valid input', async () => {
    const stages: PreflightStage[] = [];
    let seen: PreflightSnapshot | undefined;
    await evaluateWithBackstop(
      inputV2(await supportedDocumentsV2()),
      (snapshot) => {
        seen = snapshot;
        return baseline();
      },
      { trace: (stage) => stages.push(stage) },
    );
    expect(stages).toEqual(['schema', 'snapshot_integrity', 'classification', 'evaluation', 'backstop']);
    expect(seen?.versions).toHaveLength(4);
  });
});

describe('public surface', () => {
  it('exports the version 2 entry point but no preflight, evaluator, validator or forcing seam', () => {
    const exported = Object.keys(domain);
    for (const internal of [
      'preflightV2',
      'evaluateWithBackstop',
      'selectRepresentable',
      'classifySnapshot',
      'validateSchemaV2',
      'snapshotIntegrityReasons',
      'backstopRejection',
      'FORCING_SEAM',
      'INVARIANT_VIOLATION',
      'evaluateRulesV2',
      'assembleResultV3',
      'resultIssuesV3',
      'documentsRead',
    ]) {
      expect(exported).not.toContain(internal);
    }
    expect(exported).toEqual(expect.arrayContaining(['assess', 'assessV2', 'checkPolicyPackV2', 'packCoverageGaps', 'EVALUATOR_INVENTORY_V2', 'MAX_DOCUMENTS_V2', 'MAX_SOURCE_BYTES_V2']));
  });
});
