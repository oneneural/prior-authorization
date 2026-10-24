import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { liveProviderVersion, liveRunVersionsRecord, loadLiveEvaluationSettings, sdkLiveClient } from '@pa/agents';

import { evaluationAdmissionPort, evaluationRunSummary, registerEvaluationRun, stopEvaluationRun } from './live-admission-client.js';
import { buildLiveReport, formatLiveReport, LIVE_SNAPSHOTS, LIVE_SUITE_CASES, liveRunFailures, runLiveEvaluation } from './live-claude.js';
import { REPO_ROOT } from './v2/files.js';

// `pnpm test:evals:live`: paid Anthropic calls over synthetic inputs only.
// Requires PA_ANTHROPIC_API_KEY_FILE, PA_LIVE_RUN_CAP_USD, PA_ADMISSION_API_ORIGIN
// and PA_EVALUATION_ADMISSION_TOKEN_FILE: every attempt is admitted by the
// running API that owns the canonical accounting ledger, never by a local
// file. Optional PA_LIVE_EFFORT, PA_LIVE_CASES (comma list), PA_LIVE_RUN_LABEL
// and PA_LIVE_PROMPT_NOTE. Writes the content-free report to
// evals/reports/live-claude/. Never part of `pnpm test` or `pnpm test:evals`.
it('runs the bounded live Claude evaluation and holds every deterministic gate', async () => {
  const { settings, apiKeyFile, runCapUsd, admissionOrigin, admissionAuthorization } = loadLiveEvaluationSettings();
  const label = process.env.PA_LIVE_RUN_LABEL ?? 'full';
  if (!/^[a-z0-9-]{1,40}$/.test(label)) throw new Error('PA_LIVE_RUN_LABEL must be 1-40 characters of a-z, 0-9 or -');
  const cases = process.env.PA_LIVE_CASES?.split(',').map((item) => item.trim()).filter((item) => item !== '');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
  const revision = git('rev-parse', 'HEAD');
  const dirtyPaths = git('status', '--porcelain').split('\n').filter((line) => line !== '').length;
  const startedAt = new Date().toISOString();
  const admission = { origin: admissionOrigin, authorization: admissionAuthorization };
  const suiteDigest = createHash('sha256').update(JSON.stringify({ cases: cases ?? [...LIVE_SUITE_CASES, ...LIVE_SNAPSHOTS], settings })).digest('hex');
  const registered = await registerEvaluationRun(admission, { capUsd: runCapUsd, suiteDigest, versions: liveRunVersionsRecord(liveProviderVersion(settings), revision.slice(0, 40)) });
  const runId = registered.runId;
  let runs;
  try {
    runs = await runLiveEvaluation({ settings, admission: evaluationAdmissionPort(admission, runId), clientFactory: sdkLiveClient(apiKeyFile), cases });
  } finally {
    await stopEvaluationRun(admission, runId);
  }
  const report = buildLiveReport(runs, {
    runId, label, settings, revision, dirtyPaths, startedAt, finishedAt: new Date().toISOString(), ledger: await evaluationRunSummary(admission, runId),
    promptNote: process.env.PA_LIVE_PROMPT_NOTE ?? 'Prompt and tool definitions were fixed before any live call and not changed during the run.',
  });
  const dir = join(REPO_ROOT, 'evals', 'reports', 'live-claude');
  await mkdir(dir, { recursive: true });
  const base = join(dir, `${startedAt.slice(0, 10)}-${label}`);
  await writeFile(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = formatLiveReport(report);
  await writeFile(`${base}.md`, `${markdown}\n`);
  console.log(markdown);
  // A provider failure stops a case as provider_unavailable without a gate problem, so it fails the run here.
  expect(liveRunFailures(report)).toEqual([]);
}, 7_200_000);
