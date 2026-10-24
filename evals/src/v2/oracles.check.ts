import { expect, it } from 'vitest';

import { V2_BATCHES } from '../v2-batches.js';
import { runOraclesV2 } from './command.js';
import { REPO_ROOT } from './files.js';

// `pnpm test:oracles:v2`: structural validation of the real registered v2
// batches and suite. It prints the report and fails on any refusal, trust
// failure or mismatched loader-boundary expectation.

// This case validates the whole registered suite, so its time grows with each batch.
it('validates every registered v2 batch, fixture, oracle and recipe pin', async () => {
  const result = await runOraclesV2(V2_BATCHES, REPO_ROOT);
  console.log(result.report);
  expect(result.problems).toEqual([]);
  expect(result.exitCode).toBe(0);
}, 60_000);
