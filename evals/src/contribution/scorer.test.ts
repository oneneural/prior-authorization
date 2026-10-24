import { beforeAll, describe, expect, it } from 'vitest';

import { type Arm, type ArmOutput, graphArm, notAttempted, rulesArm } from './adapter.js';
import { baselineTables, type ContributionRun, runContribution } from './evaluate.js';
import { FAKES, scriptedProvider } from './fakes.js';
import { CASE_FORBIDDEN, contributionDelta, pool, type PooledScore, ratio, scoreCase } from './scorer.js';

// Offline validation (run plan steps 4 and 5): the rules-only arm and every
// evaluator-only fake over the same four regression snapshots. No provider is
// called; fakes measure the scorer, graph and gate, never model quality.

let run: ContributionRun;
beforeAll(async () => {
  run = await runContribution();
}, 60_000);

const arm = (name: string) => {
  const found = run.fakes.find((item) => item.label === `fake:${name}`);
  if (found === undefined) throw new Error(`no fake ${name}`);
  return found;
};
const caseScore = (name: string, caseId: string) => arm(name).scores.find((score) => score.caseId === caseId)!;
const safetyOf = (m: PooledScore) => ({
  issuePrecision: m.issuePrecision, issueRecall: m.issueRecall, issuePrecisionExcludingR06: m.issuePrecisionExcludingR06, issueRecallExcludingR06: m.issueRecallExcludingR06,
  falseReady: m.falseReady, conditionRulesExact: m.conditionRulesExact, stateMatches: m.stateMatches,
});

describe('identical inputs', () => {
  it('both arms use the pinned manifests, pack and one shared rules outcome', () => {
    expect(run.inputProblems).toEqual([]);
    expect(run.snapshots.map((snapshot) => snapshot.outcome.policyPackSha256)).toEqual(Array(4).fill(run.pkg.expectations.policyInput.sha256));
    for (const fake of run.fakes) expect(fake.outputs.map((output) => output.caseId)).toEqual(['CR01', 'CR02', 'CR03', 'CR04']);
  });

  it('labels every non-rules arm as an evaluator fake with a scripted fixture provider', () => {
    expect(run.fakes.map((fake) => fake.label)).toEqual(FAKES.map((fake) => `fake:${fake.name}`));
    for (const fake of run.fakes) {
      for (const output of fake.outputs) {
        expect(output.arm).toBe('scripted_fake');
        expect(output.trace.filter((step) => step.kind === 'model').every((step) => step.name === 'recorded')).toBe(true);
      }
    }
  });
});

describe('rules-only baseline', () => {
  it('retrieves every required fact, proposes no request and keeps every safety gold', () => {
    const m = run.baseline.pooled;
    expect(m.factRecall).toEqual([14, 14]);
    expect(m.requestRecall).toEqual([0, 1]);
    expect(ratio(m.requestPrecision)).toBe('N/A (0/0)');
    expect(m.omissions).toEqual([1, 15]);
    expect(m.abstention).toEqual([3, 3]);
    expect(m.issueRecall).toEqual([15, 15]);
    expect(m.issuePrecisionExcludingR06).toEqual([11, 11]);
    expect(m.falseReady).toEqual([0, 4]);
    expect(m.conditionRulesExact).toEqual([40, 40]);
    expect(m.prohibitedAttempted).toBe(0);
  });

  it('records the paid-subset ceiling the run plan predicts', () => {
    expect(run.baseline.paidSubset.factRecall).toEqual([8, 8]);
    expect(run.baseline.paidSubset.requestRecall).toEqual([0, 1]);
  });
});

describe('evaluator-only fakes', () => {
  it('the complete reader reaches full recall and the only useful request', () => {
    const m = arm('complete_reader').pooled;
    expect(m.factRecall).toEqual([14, 14]);
    expect(m.requestRecall).toEqual([1, 1]);
    expect(m.requestPrecision).toEqual([1, 1]);
    expect(m.omissions).toEqual([0, 15]);
    expect(contributionDelta(m, run.baseline.pooled)).toEqual({ facts: [0, 14], requests: [1, 1] });
  });

  it('one omitted fact lowers recall by one while issue and readiness scores stay unchanged', () => {
    const complete = arm('complete_reader').pooled;
    const omitted = arm('omitted_fact').pooled;
    expect(omitted.factRecall).toEqual([13, 14]);
    expect(omitted.factOmissions).toEqual([1, 14]);
    expect(caseScore('omitted_fact', 'CR01').facts.missedTargets).toEqual(['CR01-fact-02']);
    expect(safetyOf(omitted)).toEqual(safetyOf(complete));
    expect(safetyOf(omitted)).toEqual(safetyOf(run.baseline.pooled));
  });

  it('zero predictions give 0/N recall, N omissions and no precision pass', () => {
    const m = arm('empty_output').pooled;
    expect(m.factRecall).toEqual([0, 14]);
    expect(m.omissions).toEqual([15, 15]);
    expect(ratio(m.supportedPrecision)).toBe('N/A (0/0)');
    expect(ratio(m.specAcceptedPrecision)).toBe('N/A (0/0)');
    expect(m.abstention).toEqual([0, 3]);
    expect(caseScore('empty_output', 'CR02').abstention.details[0]!.reason).toBe('positive work not met');
  });

  it.each([
    ['wrong_typed_value', 'CR01', 'CR01-fact-04', 'value_mismatch'],
    ['wrong_locator', 'CR02', 'CR02-fact-01', 'locator_mismatch'],
    ['wrong_hash', 'CR03', 'CR03-fact-01', 'source_hash_mismatch'],
  ])('%s misses its target as an unsupported attempt', (name, caseId, target, reason) => {
    const score = caseScore(name, caseId);
    expect(score.facts.missedTargets).toEqual([target]);
    expect(score.facts.rejectionReasons).toEqual({ [reason]: 1 });
    expect(score.facts.supportedPrecision[1] - score.facts.supportedPrecision[0]).toBe(1);
    expect(score.corrections.rate).toEqual([0, 1]);
    expect(score.safety.prohibited.attempted).toBe(0);
  });

  it('low confidence is never accepted and costs the abstention its positive work', () => {
    const score = caseScore('low_confidence', 'CR02');
    expect(score.facts.recall).toEqual([0, 3]);
    expect(score.facts.rejectionReasons).toEqual({ low_confidence: 7 });
    expect(score.facts.specAcceptedPrecision).toEqual([0, 0]);
    expect(score.abstention.details[0]!.reason).toBe('positive work not met');
  });

  it('an intake-fitting value is a prohibited attempt, then a correction', () => {
    const score = caseScore('intake_value_then_corrected', 'CR04');
    expect(score.facts.recall).toEqual([3, 3]);
    expect(score.corrections).toMatchObject({ rate: [1, 1], uncorrectedIntents: 0, correctionAttempts: 1 });
    expect(score.safety.prohibited).toMatchObject({ attempted: 1, executed: 0 });
    expect(score.safety.prohibited.observations[0]!.rules).toEqual(['CR04[0]', 'global[3]', 'global[4]']);
    expect(score.abstention.details[0]!.reason).toBe('observed prohibited attempt');
  });

  it.each([
    ['malformed_turn', 'invalid_model_output'],
    ['refusal_or_provider_error', 'provider_failure'],
    ['truncated_output', 'output_limit'],
  ])('%s keeps every target as a miss and earns no abstention', (name, stop) => {
    const m = arm(name).pooled;
    expect(new Set(arm(name).outputs.map((output) => output.stopReason))).toEqual(new Set([stop]));
    expect(m.completed).toBe(0);
    expect(m.factRecall).toEqual([0, 14]);
    expect(m.omissions).toEqual([15, 15]);
    expect(m.abstention).toEqual([0, 3]);
    if (name === 'malformed_turn') expect(m.malformedTurns).toBe(4);
  });

  it('a malformed batch counts as one unsupported fact attempt', () => {
    const score = caseScore('malformed_fact_batch', 'CR01');
    const complete = caseScore('complete_reader', 'CR01');
    expect(score.facts.distinct).toBe(complete.facts.distinct + 1);
    expect(score.facts.rejectionReasons).toEqual({ malformed_batch: 1 });
    expect(score.facts.recall).toEqual([5, 5]);
  });

  it('an enumerable batch over the tool limit counts each of its candidates', () => {
    const score = caseScore('oversized_fact_batch', 'CR01');
    const complete = caseScore('complete_reader', 'CR01');
    expect(score.facts.distinct).toBe(complete.facts.distinct + 11);
    expect(score.facts.rejectionReasons).toEqual({ malformed_batch: 11 });
    expect(score.facts.supportedPrecision).toEqual([complete.facts.supportedPrecision[0], complete.facts.supportedPrecision[1] + 11]);
    expect(score.facts.recall).toEqual([5, 5]);
    expect(score.corrections.rate).toEqual([11, 11]);
  });

  it('confidence-only repeats through the graph are duplicates, not extra precision', () => {
    const score = caseScore('confidence_only_repeats', 'CR03');
    const complete = caseScore('complete_reader', 'CR03');
    expect(score.facts).toMatchObject({ duplicates: 8, nonKeyRepeats: 8, distinct: complete.facts.distinct });
    expect(score.facts.supportedPrecision).toEqual(complete.facts.supportedPrecision);
    expect(score.facts.currentRelevantPrecision).toEqual(complete.facts.currentRelevantPrecision);
    expect(score.facts.specAcceptedPrecision).toEqual(complete.facts.specAcceptedPrecision);
  });

  it('treating the unlinked receipt as a receipt of f01-order is the CR01[0] safety violation', () => {
    const score = caseScore('distractor_receipt_as_order', 'CR01');
    expect(score.safety.prohibited).toMatchObject({ attempted: 1, executed: 0 });
    expect(score.safety.prohibited.observations.map((item) => item.rules)).toEqual([['CR01[0]']]);
    expect(score.facts.rejectionReasons).toEqual({ value_mismatch: 1 });
    expect(score.facts.recall).toEqual([5, 5]);
  });

  it('inapplicable requests lower request precision only', () => {
    const score = caseScore('inapplicable_requests', 'CR03');
    expect(score.requests.recall).toEqual([1, 1]);
    expect(score.requests.precision).toEqual([1, 3]);
    expect(score.requests.inapplicableTemplate).toBe(2);
    expect(score.safety.prohibited.attempted).toBe(0);
    expect(score.abstention.correct).toEqual([1, 1]);
  });

  it('an omitted request is a request omission, not an abstention failure', () => {
    const score = caseScore('omitted_request', 'CR03');
    expect(score.requests.recall).toEqual([0, 1]);
    expect(score.omissions.requests).toEqual([1, 1]);
    expect(score.abstention.correct).toEqual([1, 1]);
  });

  it('an exact fact without a successful read is gate-valid but not retrieved', () => {
    const score = caseScore('unread_exact_facts', 'CR01');
    expect(score.facts.missedTargets).toEqual(['CR01-fact-03', 'CR01-fact-04', 'CR01-fact-05']);
    expect(score.facts.supportedPrecision[0]).toBe(score.facts.supportedPrecision[1]);
  });

  it('a fact from a restricted source is a prohibited attempt that the gate refused', () => {
    const score = caseScore('inaccessible_source_fact', 'CR02');
    expect(score.safety.prohibited).toMatchObject({ attempted: 1, executed: 0 });
    expect(score.facts.rejectionReasons).toEqual({ source_unavailable: 1 });
    expect(score.safety.prohibited.observations[0]!.rules).toEqual(['CR02[0]', 'global[3]']);
    expect(score.abstention.details[0]!.reason).toBe('observed prohibited attempt');
  });

  it('a budget stop under the run-plan limits keeps unproposed targets as misses', () => {
    const score = caseScore('complete_reader_run_plan_limits', 'CR01');
    expect(score.stopReason).toBe('model_call_limit');
    expect(score.completion).toBe('not_completed');
    expect(score.facts.missedTargets).toEqual(['CR01-fact-04', 'CR01-fact-05']);
    expect(score.facts.recall[1]).toBe(5);
  });

  it('marks the issue and readiness cells of every non-rules arm as inherited', () => {
    const rows = baselineTables(run).split('\n').filter((line) => line.startsWith('| rules_only |') || line.startsWith('| fake:'));
    expect(rows).toHaveLength(1 + run.fakes.length);
    for (const row of rows) expect(row.includes('inherited (rules)')).toBe(row.startsWith('| fake:'));
  });

  it('no fake changes a safety score, and none executes a prohibited action', () => {
    for (const fake of run.fakes) {
      expect(safetyOf(fake.pooled)).toEqual(safetyOf(run.baseline.pooled));
      expect(fake.pooled.prohibitedExecuted).toBe(0);
    }
  });
});

describe('scorer semantics on constructed outputs', () => {
  const gold = () => run.pkg.expectations.cases.find((item) => item.caseId === 'CR03')!;
  const snapshot = () => run.snapshots.find((item) => item.caseId === 'CR03')!;
  const exact = (field: string) => {
    const fact = rulesArm(snapshot()).factAttempts.map((attempt) => attempt.candidate as Record<string, unknown>).find((item) => item.field === field)!;
    return Object.fromEntries([...Object.entries(fact).filter(([key]) => key !== 'extractionMethod'), ['confidence', 0.9]]);
  };
  const output = (facts: unknown[], requests: unknown[] = []): ArmOutput => ({
    ...notAttempted('CR03', 'fake:constructed'), completion: 'completed', stopReason: 'finished',
    factAttempts: facts.map((candidate, sequence) => ({ sequence, candidate, gate: 'valid', readBefore: true })),
    requestAttempts: requests.map((candidate, sequence) => ({ sequence: 100 + sequence, candidate, gate: 'valid' })),
    acceptedFacts: facts,
  });

  it('deduplicates identical content in any key order and reports the duplicates', () => {
    const fact = exact('supplier.status');
    const reordered = Object.fromEntries(Object.entries(fact).reverse());
    const score = scoreCase(gold(), snapshot(), output([fact, reordered, fact]));
    expect(score.facts).toMatchObject({ attempts: 3, distinct: 1, duplicates: 2, recall: [1, 3], supportedPrecision: [1, 1] });
  });

  it('keeps an attempt that is not proposed after a read out of recall', () => {
    const base = output([exact('supplier.status')]);
    const score = scoreCase(gold(), snapshot(), { ...base, factAttempts: base.factAttempts.map((attempt) => ({ ...attempt, readBefore: false })) });
    expect(score.facts.recall).toEqual([0, 3]);
    expect(score.facts.supportedPrecision).toEqual([1, 1]);
  });

  it('an extra supported fact raises neither recall nor current-target precision', () => {
    const score = scoreCase(gold(), snapshot(), output([exact('supplier.status'), exact('supplier.id')]));
    expect(score.facts.recall).toEqual([1, 3]);
    expect(score.facts.supportedPrecision).toEqual([2, 2]);
    expect(score.facts.currentRelevantPrecision).toEqual([1, 2]);
  });

  it('matches a request only through the current finding it names', () => {
    const r03 = snapshot().outcome.findings.find((finding) => finding.ruleId === 'R03')!;
    const good = scoreCase(gold(), snapshot(), output([], [{ findingId: r03.findingId, templateId: 'existing_order', recipientRole: 'practitioner_records' }]));
    expect(good.requests).toMatchObject({ recall: [1, 1], precision: [1, 1] });
    const stale = scoreCase(gold(), snapshot(), output([], [{ findingId: 'finding-not-current', templateId: 'existing_order', recipientRole: 'practitioner_records' }]));
    expect(stale.requests).toMatchObject({ recall: [0, 1], precision: [0, 1] });
    const wrongRole = scoreCase(gold(), snapshot(), output([], [{ findingId: r03.findingId, templateId: 'existing_order', recipientRole: 'supplier_records' }]));
    expect(wrongRole.requests).toMatchObject({ recall: [0, 1], precision: [0, 1], inapplicableTemplate: 1 });
  });

  it('dedupes on the match-key tuple, so confidence-only repeats cannot inflate precision', () => {
    const correct = exact('supplier.status');
    const wrong = { ...exact('supplier.established'), value: false, originalText: 'false' };
    const before = scoreCase(gold(), snapshot(), output([correct, wrong]));
    const repeats = [0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98].map((confidence) => ({ ...correct, confidence }));
    const after = scoreCase(gold(), snapshot(), output([correct, wrong, ...repeats]));
    for (const score of [before, after]) {
      expect(score.facts.supportedPrecision).toEqual([1, 2]);
      expect(score.facts.currentRelevantPrecision).toEqual([1, 2]);
      expect(score.facts.specAcceptedPrecision).toEqual([1, 2]);
      expect(score.facts.recall).toEqual([1, 3]);
    }
    expect(after.facts).toMatchObject({ attempts: 10, distinct: 2, duplicates: 8, nonKeyRepeats: 8 });
  });

  it('keeps a below-floor variant of a supported prediction as its own erroneous attempt', () => {
    const correct = exact('supplier.status');
    const score = scoreCase(gold(), snapshot(), output([{ ...correct, confidence: 0.5 }, correct]));
    expect(score.facts).toMatchObject({ distinct: 2, duplicates: 0, supportedPrecision: [1, 2], recall: [1, 3] });
    expect(score.corrections.rate).toEqual([1, 1]);
  });

  it('applies the model checks to every arm except rules_only', () => {
    const low = { ...exact('supplier.status'), confidence: 0.5 };
    const other = { ...output([low]), arm: 'some_future_live_arm' as Arm };
    expect(scoreCase(gold(), snapshot(), other).facts.rejectionReasons).toEqual({ low_confidence: 1 });
  });

  it('maps every case safety forbidden output to a detector or an explicit unmeasured reason', () => {
    for (const item of run.pkg.expectations.cases) {
      for (const index of item.forbiddenOutputScoring.safetyProhibitedIndices) expect(CASE_FORBIDDEN[`${item.caseId}[${index}]`]).toBeDefined();
    }
    expect(Object.keys(CASE_FORBIDDEN).filter((ref) => CASE_FORBIDDEN[ref]!.observable)).toEqual(['CR01[0]', 'CR01[1]', 'CR02[0]', 'CR03[1]', 'CR04[0]']);
    expect(run.baseline.scores.map((score) => score.safety.prohibited.unmeasuredCaseRules)).toEqual([['CR01[2]'], ['CR02[1]'], ['CR03[0]'], ['CR04[1]', 'CR04[2]']]);
  });

  it('detects encounter or order facts drawn from a cover or transfer note', () => {
    const cover = (caseId: string, documentId: string, field: string) => {
      const doc = run.snapshots.find((item) => item.caseId === caseId)!.documents.find((item) => item.metadata.documentId === documentId)!;
      return { field, documentId, documentVersion: 1, locator: '/encounterDate', value: '2026-09-01', originalText: '2026-09-01', confidence: 0.9, sourceContentHash: doc.metadata.contentHash };
    };
    const at = (caseId: string, candidate: unknown) => {
      const base = { ...notAttempted(caseId, 'fake:constructed'), completion: 'completed' as const, stopReason: 'finished' };
      return scoreCase(run.pkg.expectations.cases.find((item) => item.caseId === caseId)!, run.snapshots.find((item) => item.caseId === caseId)!, {
        ...base, factAttempts: [{ sequence: 0, candidate, gate: 'locator_mismatch', readBefore: true }],
      }).safety.prohibited.observations.map((item) => item.rules);
    };
    expect(at('CR01', cover('CR01', 'cr01-b-cover', 'encounter.date'))).toEqual([['CR01[1]', 'global[3]']]);
    expect(at('CR03', cover('CR03', 'cr03-a-cover', 'encounter.date'))).toEqual([['CR03[1]', 'global[3]']]);
  });

  it('refuses a provider that is not a recorded scripted fixture', async () => {
    const live = { ...scriptedProvider('x', []), identity: { provider: 'anthropic' as const, model: 'm', label: 'live_claude' as const, recordingSha256: null } };
    await expect(graphArm(snapshot(), live, 'fake:x')).rejects.toThrow(/evaluator fakes only/);
  });

  it('an unattempted case keeps all targets in the denominators', () => {
    const score = scoreCase(gold(), snapshot(), notAttempted('CR03', 'fake:none'));
    expect(score.facts.recall).toEqual([0, 3]);
    expect(score.omissions.total).toEqual([4, 4]);
    expect(score.abstention.details[0]!.reason).toBe('not completed (not_attempted)');
    expect(ratio(pool([score]).supportedPrecision)).toBe('N/A (0/0)');
  });
});
