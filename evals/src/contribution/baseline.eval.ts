import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { REPO_ROOT } from '../v2/files.js';
import { baselineRecord, baselineTables, runContribution } from './evaluate.js';

// Frozen offline baseline: recomputes the rules-only arm over the four regression
// cases and requires the committed record and report tables to match.
// No provider call. A changed count, output hash or input pin fails here.

const REPORT = join(REPO_ROOT, 'evals', 'reports', 'contribution', '2026-10-24-baseline');

it('the rules-only contribution baseline matches its frozen record and report', async () => {
  const run = await runContribution();
  expect(run.sums.mismatched).toEqual([]);
  expect(run.sums.missing).toEqual([]);
  expect(run.inputProblems).toEqual([]);
  const committed = JSON.parse(await readFile(`${REPORT}.json`, 'utf8')) as { record: unknown };
  expect(baselineRecord(run)).toEqual(committed.record);
  const report = await readFile(`${REPORT}.md`, 'utf8');
  for (const table of baselineTables(run).split('\n\n')) expect(report).toContain(table);
}, 60_000);
