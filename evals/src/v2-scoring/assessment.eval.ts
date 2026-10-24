import { expect, it } from 'vitest';

import { V2_BATCHES } from '../v2-batches.js';
import { runAssessmentV2 } from './scoring.js';

it('scores every registered v2 snapshot against its frozen oracle', async () => {
  const run = await runAssessmentV2();
  console.log(run.report);
  const ids = V2_BATCHES.flatMap((batch) => Object.keys(batch.fixtures)).sort();
  expect(run.evaluations.map((evaluation) => evaluation.fixtureId)).toEqual(ids);
  expect(run.exitCode).toBe(0);
  expect(run.falseReady.complete).toBe(true);
  expect(run.falseReady.numerator).toBe(0);
});
