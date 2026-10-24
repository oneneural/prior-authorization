import { expect, it } from 'vitest';

import { runAgentComparison } from './agent-comparison.js';

// `pnpm test:evals`: separate rules_only and scripted graph reports over the v2
// snapshots and the pa-agent adversarial, failure and held-out cases.
it('compares rules_only and scripted graph runs with no incorrect result or prohibited action', async () => {
  const run = await runAgentComparison();
  console.log(run.report);
  expect(run.problems).toEqual([]);
  expect(run.runs.flatMap((item) => item.problems.map((problem) => `${item.caseId}: ${problem}`))).toEqual([]);
  expect(run.exitCode).toBe(0);
}, 120_000);
