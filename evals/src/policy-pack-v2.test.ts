import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PolicyPack, PolicyPackV2, RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { POLICY_PACK_PATH, REPO_ROOT, STATE_EFFECT_RANK } from './fixture.js';

const V2_PATH = join(REPO_ROOT, 'policy-packs', 'lab-k0823-jd-20261018-v2.json');
const bytes = await readFile(V2_PATH);
const raw: unknown = JSON.parse(bytes.toString('utf8'));
const pack = PolicyPackV2.parse(raw);
const legacy = PolicyPack.parse(JSON.parse(await readFile(POLICY_PACK_PATH, 'utf8')));

const rule = (ruleId: RuleId) => {
  const found = pack.rules.find((candidate) => candidate.ruleId === ruleId);
  if (found === undefined) {
    throw new Error(`rule ${ruleId} missing`);
  }
  return found;
};
const effects = (ruleId: RuleId) => Object.fromEntries(rule(ruleId).outcomes.map((outcome) => [outcome.status, outcome.stateEffect]));
const keys = (ruleId: RuleId) => rule(ruleId).outcomes.flatMap((outcome) => outcome.conditions.map((condition) => condition.conditionKey));
const declaration = (conditionKey: string) => {
  for (const candidate of pack.rules) {
    for (const outcome of candidate.outcomes) {
      const found = outcome.conditions.find((condition) => condition.conditionKey === conditionKey);
      if (found !== undefined) {
        return { ...found, status: outcome.status, stateEffect: outcome.stateEffect, responsibleRole: outcome.responsibleRole };
      }
    }
  }
  throw new Error(`condition ${conditionKey} missing`);
};

describe('lab policy pack lab-k0823-jd-20261018-v2', () => {
  it('parses as pa.policy-pack.v2 without changing any byte of its text', () => {
    expect(pack.schemaVersion).toBe('pa.policy-pack.v2');
    expect(pack.packId).toBe('lab-k0823-jd-20261018-v2');
    expect(pack.version).toBe(2);
    // The parser is non-transforming, so the parsed pack re-serializes to its input.
    expect(JSON.stringify(pack)).toBe(JSON.stringify(raw));
  });

  it('is stored with LF line endings and no byte order mark', () => {
    expect(bytes.includes(0x0d)).toBe(false);
    expect(bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))).toBe(false);
    expect(bytes.at(-1)).toBe(0x0a);
  });

  it('keeps the version 1 scope, dates, sources and rule set', () => {
    expect(pack.scope).toEqual(legacy.scope);
    expect(pack.reviewedAsOf).toBe('2026-10-18');
    expect(pack.supportedAssessmentDates).toEqual(['2026-10-18']);
    expect(pack.sourceRefs).toEqual(legacy.sourceRefs);
    expect(pack.rules.map((candidate) => candidate.ruleId)).toEqual(RuleId.options);
    for (const candidate of pack.rules) {
      const previous = legacy.rules.find((old) => old.ruleId === candidate.ruleId);
      // R03 now rests on the C09 per-order lab convention as well as S09.
      expect(candidate.basis, candidate.ruleId).toBe(candidate.ruleId === 'R03' ? 'source_and_lab' : previous?.basis);
      expect(candidate.severity, candidate.ruleId).toBe(previous?.severity);
      expect(candidate.evidenceFields, candidate.ruleId).toEqual(previous?.evidenceFields);
      expect(candidate.sourceSections.map((section) => section.sourceRefId), candidate.ruleId).toEqual(previous?.sourceSections.map((section) => section.sourceRefId));
    }
  });

  it('changes outcome statuses only by adding the R01 manual_review outcome (D4)', () => {
    for (const candidate of pack.rules) {
      const previous = legacy.rules.find((old) => old.ruleId === candidate.ruleId);
      const statuses = candidate.outcomes.map((outcome) => outcome.status);
      const expected = previous?.outcomes.map((outcome) => outcome.status) ?? [];
      expect(statuses, candidate.ruleId).toEqual(candidate.ruleId === 'R01' ? ['conflict', 'manual_review', 'restricted', 'unreadable', 'missing', 'pass'] : expected);
    }
    expect(rule('R01').outcomes.find((outcome) => outcome.status === 'manual_review')).toMatchObject({
      responsibleRole: 'administrative_reviewer',
      stateEffect: 'scope_hold',
    });
    expect(new Set(rule('R01').outcomes.filter((outcome) => outcome.status !== 'pass').map((outcome) => outcome.stateEffect))).toEqual(new Set(['scope_hold']));
  });

  it('keeps every version 1 state effect, so SPEC precedence is unchanged', () => {
    for (const candidate of pack.rules) {
      const previous = legacy.rules.find((old) => old.ruleId === candidate.ruleId);
      for (const outcome of previous?.outcomes ?? []) {
        expect(effects(candidate.ruleId)[outcome.status], `${candidate.ruleId} ${outcome.status}`).toBe(outcome.stateEffect);
      }
    }
  });

  it('orders every rule\'s outcomes so that no outcome precedes one with a higher state effect (C05)', () => {
    for (const candidate of pack.rules) {
      const ranks = candidate.outcomes.map((outcome) => STATE_EFFECT_RANK[outcome.stateEffect]);
      expect(ranks, candidate.ruleId).toEqual([...ranks].sort((a, b) => b - a));
    }
  });

  it('freezes the complete condition vocabulary (D2)', () => {
    expect(Object.fromEntries(RuleId.options.map((ruleId) => [ruleId, keys(ruleId)]))).toEqual({
      R01: [
        'R01.scope_fact_unsupported',
        'R01.case_supplier_interval_excludes_date',
        'R01.supplier_id_disagrees',
        'R01.supplier_record_disagrees',
        'R01.supplier_record_interval_excludes_date',
        'R01.order_item_code_disagrees',
        'R01.supplier_record_failed_provenance',
        'R01.supplier_record_restricted',
        'R01.supplier_record_unreadable',
        'R01.scope_fact_unknown',
        'R01.supplier_record_value_unknown',
        'R01.supplier_record_not_supplied',
      ],
      R02: ['R02.document_quarantined'],
      R03: [
        'R03.orders_disagree',
        'R03.order_failed_provenance',
        'R03.order_restricted',
        'R03.order_unreadable',
        'R03.no_usable_order',
        'R03.element_missing',
      ],
      R04: [
        'R04.practitioner_identifier_differs',
        'R04.order_before_encounter',
        'R04.order_after_bound',
        'R04.encounters_disagree',
        'R04.orders_disagree',
        'R04.same_day_unsequenced',
        'R04.practitioner_identifier_absent',
        'R04.lcmp_stated_by_case',
        'R04.lcmp_stated_by_encounter',
        'R04.encounter_failed_provenance',
        'R04.order_failed_provenance',
        'R04.encounter_restricted',
        'R04.order_restricted',
        'R04.encounter_unreadable',
        'R04.order_unreadable',
        'R04.no_usable_encounter',
        'R04.no_usable_order',
        'R04.encounter_not_final',
        'R04.order_not_final',
        'R04.date_not_stated',
      ],
      R05: [
        'R05.receipt_before_order',
        'R05.receipt_unsequenced',
        'R05.receipt_failed_provenance',
        'R05.receipt_restricted',
        'R05.receipt_unreadable',
        'R05.no_usable_receipt',
        'R05.order_receipt_missing',
        'R05.no_usable_order',
      ],
      R06: ['R06.clinical_review'],
      R07: ['R07.lcmp_stated_by_case', 'R07.lcmp_stated_by_encounter'],
      R08: ['R08.pack_id_differs', 'R08.assessment_date_unsupported', 'R08.pack_unreviewed', 'R08.pack_unsourced'],
      R09: ['R09.hash_mismatch', 'R09.kind_mismatch', 'R09.locator_unresolved', 'R09.access_restricted', 'R09.access_unreadable', 'R09.mime_unsupported', 'R09.body_invalid'],
      R10: ['R10.pure_assessment'],
    });
  });

  it('qualifies evidence-field conditions only by fields the rule cites', () => {
    for (const candidate of pack.rules) {
      for (const outcome of candidate.outcomes) {
        for (const condition of outcome.conditions.filter((entry) => entry.qualifier === 'evidence_field')) {
          expect(candidate.evidenceFields, condition.conditionKey).toEqual(expect.arrayContaining(condition.fields));
        }
      }
    }
  });

  it('declares the document arity of per-document, pairwise and aggregate conditions', () => {
    expect(declaration('R02.document_quarantined')).toMatchObject({ documentArity: 'one', qualifier: 'binding_basis' });
    expect(declaration('R03.orders_disagree')).toMatchObject({ documentArity: 'two_or_more', documentKinds: ['order'] });
    expect(declaration('R03.element_missing')).toMatchObject({ documentArity: 'one', qualifier: 'order_element' });
    expect(declaration('R04.same_day_unsequenced')).toMatchObject({ documentArity: 'two', documentKinds: ['encounter', 'order'] });
    expect(declaration('R05.receipt_before_order')).toMatchObject({ documentArity: 'two', documentKinds: ['order_receipt', 'order'] });
    expect(declaration('R05.order_receipt_missing')).toMatchObject({ documentArity: 'one', documentKinds: ['order'] });
    expect(declaration('R05.no_usable_receipt')).toMatchObject({ documentArity: 'none' });
    expect(declaration('R01.scope_fact_unknown')).toMatchObject({ documentArity: 'none', qualifier: 'case_scope_field' });
  });

  it('routes failed supplier provenance to administrative review with a scope hold (D4)', () => {
    expect(declaration('R01.supplier_record_failed_provenance')).toMatchObject({
      status: 'manual_review',
      responsibleRole: 'administrative_reviewer',
      stateEffect: 'scope_hold',
      documentArity: 'one',
      documentKinds: ['supplier_status'],
    });
  });

  it('keeps clinical review and the pure-assessment R10 outcome non-blocking', () => {
    expect(declaration('R06.clinical_review')).toMatchObject({ status: 'manual_review', responsibleRole: 'qualified_clinical_reviewer', stateEffect: 'none' });
    expect(rule('R06').outcomes).toHaveLength(1);
    expect(declaration('R10.pure_assessment')).toMatchObject({ status: 'not_applicable', stateEffect: 'none' });
    expect(rule('R10').outcomes).toHaveLength(1);
  });

  it('classifies every supplied version before R02 compares a body', () => {
    expect(rule('R09').applicability.condition).toMatch(/before R02 compares any body/);
    expect(rule('R02').requirement).toMatch(/quarantined by exact version/);
    expect(rule('R02').requirement).toMatch(/exactly \(no trimming/);
  });

  it('states its lab conventions, including the supersession and quantifier conventions', () => {
    expect(pack.labConventions.map((convention) => convention.conventionId)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07', 'C08', 'C09']);
    const statement = (conventionId: string) => pack.labConventions.find((convention) => convention.conventionId === conventionId)?.statement ?? '';
    const changed = legacy.labConventions.filter((convention) => statement(convention.conventionId) !== convention.statement).map((convention) => convention.conventionId);
    // C04 adds non-suppression, C05 and C07 adopt conditions, C06 closes the boundary and equal-instant cases.
    expect(changed).toEqual(['C04', 'C05', 'C06', 'C07']);
    expect(statement('C06')).toMatch(/both ends included/);
    expect(statement('C06')).toMatch(/same instant as the stated order timestamp, is not sequenced/);
    expect(statement('C08')).toMatch(/never inferred from document text, a model response, a filename or confidence/);
    expect(statement('C08')).toMatch(/independent of input order/);
    expect(statement('C09')).toMatch(/not CMS requirements/);
    expect(pack.limitations.join(' ')).toMatch(/not a complete statement of Medicare policy/);
  });

  it('imposes no generic checklist item', () => {
    const fields = pack.rules.flatMap((candidate) => candidate.evidenceFields);
    expect(fields.filter((field) => /atp|specialty|delivery|home_assessment/.test(field))).toEqual([]);
  });

  it('has no em dash in any reviewed text', () => {
    expect(bytes.toString('utf8')).not.toMatch(/\u2014/);
  });
});
