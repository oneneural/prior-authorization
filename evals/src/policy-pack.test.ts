import { readFile } from 'node:fs/promises';

import { PolicyPack, RuleId } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { POLICY_PACK_PATH, STATE_EFFECT_RANK } from './fixture.js';

const pack = PolicyPack.parse(JSON.parse(await readFile(POLICY_PACK_PATH, 'utf8')));
const rule = (ruleId: RuleId) => {
  const found = pack.rules.find((candidate) => candidate.ruleId === ruleId);
  if (found === undefined) {
    throw new Error(`rule ${ruleId} missing`);
  }
  return found;
};
const effects = (ruleId: RuleId) => Object.fromEntries(rule(ruleId).outcomes.map((outcome) => [outcome.status, outcome.stateEffect]));

describe('lab policy pack lab-k0823-jd-20261018-v1', () => {
  it('is reviewed for exactly the supported scenario date', () => {
    expect(pack.packId).toBe('lab-k0823-jd-20261018-v1');
    expect(pack.reviewedAsOf).toBe('2026-10-18');
    expect(pack.supportedAssessmentDates).toEqual(['2026-10-18']);
  });

  it('states the SPEC first-case scope explicitly', () => {
    expect(pack.scope).toEqual({
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
    });
  });

  it('defines R01 to R10 once each, in order, for the initial K0823 packet stage', () => {
    expect(pack.rules.map((candidate) => candidate.ruleId)).toEqual(RuleId.options);
    for (const candidate of pack.rules) {
      expect(candidate.applicability.stage).toBe('initial_request_packet');
      expect(candidate.applicability.itemCodes).toEqual(['K0823']);
      expect(candidate.applicability.requestKinds).toEqual(['initial']);
    }
  });

  it('records retrieval separately from source dates and links every source over HTTPS', () => {
    expect(pack.sourceRefs.map((source) => source.sourceRefId)).toEqual(['S06', 'S07', 'S08', 'S09', 'S10', 'S11', 'S12', 'S14']);
    for (const source of pack.sourceRefs) {
      expect(source.retrievedOn).toBe('2026-10-18');
      expect(new URL(source.url).protocol).toBe('https:');
    }
    const lcd = pack.sourceRefs.find((source) => source.sourceRefId === 'S08');
    expect(lcd?.effectiveOn).toBe('2025-10-01');
    expect(lcd?.effectiveOn).not.toBe(lcd?.retrievedOn);
  });

  it('marks proposed lab rules as lab-only', () => {
    expect(pack.rules.filter((candidate) => candidate.basis === 'lab').map((candidate) => candidate.ruleId)).toEqual(['R02', 'R08', 'R10']);
  });

  it('follows the SPEC state precedence in rule outcomes', () => {
    expect(new Set(Object.values(effects('R01')).filter((effect) => effect !== 'none'))).toEqual(new Set(['scope_hold']));
    expect(effects('R08')).toEqual({ conflict: 'scope_hold', missing: 'scope_hold', pass: 'none' });
    expect(effects('R02')).toEqual({ conflict: 'needs_human_review', pass: 'none' });
    expect(effects('R03').missing).toBe('needs_information');
    expect(effects('R04')).toMatchObject({ conflict: 'needs_human_review', manual_review: 'needs_human_review', missing: 'needs_information' });
    expect(effects('R05')).toMatchObject({ conflict: 'needs_human_review', manual_review: 'needs_human_review', missing: 'needs_information' });
    expect(effects('R07')).toEqual({ manual_review: 'needs_human_review', pass: 'none' });
  });

  it('orders every rule\'s outcomes so that no outcome precedes one with a higher state effect (C05)', () => {
    for (const candidate of pack.rules) {
      const ranks = candidate.outcomes.map((outcome) => STATE_EFFECT_RANK[outcome.stateEffect]);
      expect(ranks, candidate.ruleId).toEqual([...ranks].sort((a, b) => b - a));
    }
  });

  it('checks R09 provenance before R02 reads a body', () => {
    expect(rule('R09').applicability.condition).toMatch(/before R02 compares any body/);
    expect(rule('R02').applicability.condition).toMatch(/after the R09 hash, parse and kind checks/);
    expect(rule('R02').applicability.condition).toMatch(/excluded by R09 \(conflict\) and is not quarantined/);
  });

  it('keeps clinical findings visible without blocking or satisfying readiness', () => {
    expect(rule('R06').outcomes).toEqual([
      expect.objectContaining({ status: 'manual_review', responsibleRole: 'qualified_clinical_reviewer', stateEffect: 'none' }),
    ]);
    expect(rule('R06').evidenceFields.every((field) => field.startsWith('clinical.'))).toBe(true);
    expect(rule('R06').severity).toBe('non_blocking');
  });

  it('maps access denied, unreadable content and failed provenance to distinct outcomes (R09)', () => {
    expect(effects('R09')).toEqual({
      conflict: 'needs_human_review',
      restricted: 'needs_information',
      unreadable: 'needs_information',
      pass: 'none',
    });
    for (const ruleId of ['R03', 'R04', 'R05'] as const) {
      expect(Object.keys(effects(ruleId))).toEqual(expect.arrayContaining(['restricted', 'unreadable', 'manual_review']));
    }
  });

  it('defers R10 to the durable workflow', () => {
    expect(rule('R10').outcomes.map((outcome) => outcome.status)).toEqual(['not_applicable']);
  });

  it('imposes no generic checklist item: no rule consults ATP, specialty evaluation or delivery evidence', () => {
    const fields = pack.rules.flatMap((candidate) => candidate.evidenceFields);
    expect(fields.filter((field) => /atp|specialty|delivery|home_assessment/.test(field))).toEqual([]);
  });

  it('states its lab conventions and limitations as such', () => {
    expect(pack.labConventions.map((convention) => convention.conventionId)).toEqual(['C01', 'C02', 'C03', 'C04', 'C05', 'C06', 'C07']);
    expect(pack.labConventions[0]?.statement).toMatch(/not a legal interpretation/);
    expect(pack.limitations.join(' ')).toMatch(/authored lab subset/i);
    expect(pack.limitations.join(' ')).toMatch(/not a complete statement of Medicare policy/);
  });

  it('reports a plain-text source as unreadable rather than ignoring it', () => {
    expect(pack.scope.documentMimeTypes).toEqual(['application/json']);
    expect(pack.limitations.join(' ')).toMatch(/text\/plain document is reported unreadable by R09/);
    expect(rule('R09').outcomes.find((outcome) => outcome.status === 'unreadable')?.condition).toMatch(/MIME type outside documentMimeTypes/);
  });
});
