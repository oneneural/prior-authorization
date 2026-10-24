import { describe, expect, it } from 'vitest';

import { FROZEN_ORACLES } from './frozen.js';
import { evaluateFixture, type FixtureEvaluation, falseReady, formatReport, loadFixtureInputs } from './harness.js';

// `pnpm test:evals`: the rules-only assessment against every frozen first-slice
// oracle, compared as complete sets, with the false-ready count (SPEC PA-A02).
const SLICE = Object.keys(FROZEN_ORACLES);
const evaluations: FixtureEvaluation[] = [];

describe('rules-only assessment against the frozen first-slice oracles', () => {
  it.each(SLICE)('%s matches its oracle as a complete set', async (fixtureId) => {
    const evaluation = await evaluateFixture(await loadFixtureInputs(fixtureId));
    evaluations.push(evaluation);
    expect(evaluation.problems).toEqual([]);
  });

  it('reports the comparison and no false-ready case', () => {
    console.log(formatReport(evaluations));
    expect(evaluations.map((evaluation) => evaluation.fixtureId)).toEqual(SLICE);
    const { numerator, denominator, complete } = falseReady(evaluations);
    expect(complete).toBe(true);
    expect(denominator).toBeGreaterThan(0);
    expect(numerator).toBe(0);
  });
});
