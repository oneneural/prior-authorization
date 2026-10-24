import { performance } from 'node:perf_hooks';

import { type AssessmentResultV3 } from '@pa/contracts';

import { REPO_ROOT } from '../v2/files.js';
import { ADAPTER_VERSION, type ArmOutput, type CaseSnapshot, graphArm, loadSnapshot, rulesArm } from './adapter.js';
import { FAKES, scriptedProvider } from './fakes.js';
import { type ContributionPackage, loadContributionPackage, sha256, type SumsCheck, verifyPackage } from './package.js';
import { canonical, type CaseScore, type Count, pool, type PooledScore, ratio, SCORER_VERSION, scoreCase } from './scorer.js';

// Offline contribution run: rules-only baseline plus evaluator-only fakes over
// the four regression cases. No provider is called. `PAID_SUBSET` is the run
// plan's predeclared two-case comparison subset, in its comparison order.

export const PAID_SUBSET = ['CR01', 'CR03'] as const;

export interface ArmRun { label: string; description: string; outputs: ArmOutput[]; scores: CaseScore[]; pooled: PooledScore; paidSubset: PooledScore }

export interface ContributionRun {
  pkg: ContributionPackage;
  sums: SumsCheck;
  snapshots: CaseSnapshot[];
  inputProblems: string[];
  baseline: ArmRun & { outputSha256: Record<string, string>; cohortOutputSha256: string; latencyMs: Record<string, number> };
  fakes: ArmRun[];
}

/** Hash of the recorded arm output without timings, so it is stable across runs. */
export function outputHash(output: ArmOutput) {
  return sha256(canonical({ ...output, latencyMs: null, trace: null }));
}

const subset = (scores: readonly CaseScore[]) => pool(scores.filter((score) => (PAID_SUBSET as readonly string[]).includes(score.caseId)));

/** Identical inputs for both arms: pinned manifest, pack and the same assessment outcome object. */
function inputProblemsOf(pkg: ContributionPackage, snapshots: readonly CaseSnapshot[]) {
  const problems: string[] = [];
  for (const snapshot of snapshots) {
    const gold = pkg.expectations.cases.find((item) => item.caseId === snapshot.caseId)!;
    if (snapshot.manifestSha256 !== gold.fixtureManifestSha256) problems.push(`${snapshot.caseId}: manifest hash differs from the frozen gold`);
    if (snapshot.fixture.policyInputPath !== pkg.expectations.policyInput.path || snapshot.policyPackSha256 !== pkg.expectations.policyInput.sha256) problems.push(`${snapshot.caseId}: policy input differs from the frozen pin`);
    if (snapshot.outcome.policyPackId !== pkg.expectations.policyInput.packId) problems.push(`${snapshot.caseId}: assessed with another pack`);
  }
  return problems;
}

export async function runContribution(repoRoot = REPO_ROOT): Promise<ContributionRun> {
  const pkg = await loadContributionPackage(repoRoot);
  const sums = await verifyPackage(repoRoot);
  const snapshots: CaseSnapshot[] = [];
  const latencyMs: Record<string, number> = {};
  for (const gold of pkg.expectations.cases) {
    const started = performance.now();
    snapshots.push(await loadSnapshot(gold.caseId, repoRoot));
    latencyMs[gold.caseId] = performance.now() - started;
  }
  const goldOf = (caseId: string) => pkg.expectations.cases.find((item) => item.caseId === caseId)!;

  const baselineOutputs = snapshots.map((snapshot) => rulesArm(snapshot, latencyMs[snapshot.caseId]));
  const baselineScores = baselineOutputs.map((output, index) => scoreCase(goldOf(output.caseId), snapshots[index]!, output));
  const outputSha256 = Object.fromEntries(baselineOutputs.map((output) => [output.caseId, outputHash(output)]));

  const fakes: ArmRun[] = [];
  for (const fake of FAKES) {
    const outputs: ArmOutput[] = [];
    for (const snapshot of snapshots) outputs.push(await graphArm(snapshot, scriptedProvider(fake.name, fake.turns(snapshot)), `fake:${fake.name}`, fake.limits));
    const scores = outputs.map((output, index) => scoreCase(goldOf(output.caseId), snapshots[index]!, output));
    fakes.push({ label: `fake:${fake.name}`, description: fake.description, outputs, scores, pooled: pool(scores), paidSubset: subset(scores) });
  }

  return {
    pkg, sums, snapshots, inputProblems: inputProblemsOf(pkg, snapshots),
    baseline: {
      label: 'rules_only', description: 'Deterministic assessV2 cited evidence; no requests', outputs: baselineOutputs, scores: baselineScores,
      pooled: pool(baselineScores), paidSubset: subset(baselineScores), outputSha256, cohortOutputSha256: sha256(canonical(outputSha256)), latencyMs,
    },
    fakes,
  };
}

/** The run plan's ceiling: what an agent arm could still add over this baseline on the comparison subset. */
export function attainableDelta(baseline: PooledScore): { facts: Count; requests: Count } {
  return { facts: [baseline.factRecall[1] - baseline.factRecall[0], baseline.factRecall[1]], requests: [baseline.requestRecall[1] - baseline.requestRecall[0], baseline.requestRecall[1]] };
}

/** Issue and readiness cells of a non-rules arm are the deterministic outcome it cannot change, never its own performance. */
export const safetyCell = (rulesArm: boolean, text: string) => (rulesArm ? text : `inherited (rules) ${text}`);

const issues = (result: AssessmentResultV3) => result.findings.filter((finding) => finding.status !== 'pass' && finding.status !== 'not_applicable').map((finding) => `${finding.ruleId}:${finding.status}`).join(' ');
const pair = ([numerator, denominator]: Count) => `${numerator}/${denominator}`;

/** Deterministic report tables (no timings), regenerated and compared by the baseline eval. */
export function baselineTables(run: ContributionRun): string {
  const utility = [
    '| Cohort/case and arm | Matched required facts / planned targets | Useful requests / targets | Useful requests / all request attempts | Fact/request omissions | Abstentions correct / planned | Stop reason | Completed? |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.baseline.scores.map((score) => `| ${score.caseId} rules_only | ${pair(score.facts.recall)} | ${pair(score.requests.recall)} | ${ratio(score.requests.precision)} | ${pair(score.omissions.facts)} / ${pair(score.omissions.requests)} | ${pair(score.abstention.correct)} | ${score.stopReason} | ${score.completion === 'completed' ? 'yes' : 'no'} |`),
    ...([['Comparison subset CR01+CR03', run.baseline.paidSubset], ['Regression cohort CR01-CR04', run.baseline.pooled]] as const).map(([name, m]) =>
      `| ${name} rules_only | ${ratio(m.factRecall)} | ${ratio(m.requestRecall)} | ${ratio(m.requestPrecision)} | ${pair(m.factOmissions)} / ${pair(m.requestOmissions)} | ${ratio(m.abstention)} | assessed | ${m.completed}/${m.cases} |`),
  ];
  const precision = [
    '| Cohort/case and arm | Correct source-supported attempted predictions / all attempted predictions | Correct supported accepted extractions / all accepted extractions (SPEC) | Current required-target matches / all attempted predictions |',
    '| --- | --- | --- | --- |',
    ...run.baseline.scores.map((score) => `| ${score.caseId} rules_only | ${ratio(score.facts.supportedPrecision)} | ${ratio(score.facts.specAcceptedPrecision)} | ${ratio(score.facts.currentRelevantPrecision)} |`),
    ...([['Comparison subset CR01+CR03', run.baseline.paidSubset], ['Regression cohort CR01-CR04', run.baseline.pooled]] as const).map(([name, m]) =>
      `| ${name} rules_only | ${ratio(m.supportedPrecision)} | ${ratio(m.specAcceptedPrecision)} | ${ratio(m.currentRelevantPrecision)} |`),
  ];
  const safety = [
    '| Cohort/case and arm | Issue precision with R06 | Issue recall with R06 | Issue precision excluding R06 | Issue recall excluding R06 | False-ready / blocked cases | Prohibited attempts / executions |',
    '| --- | --- | --- | --- | --- | --- | --- |',
    ...run.baseline.scores.map((score) => `| ${score.caseId} rules_only | ${ratio(score.safety.issuePrecision)} | ${ratio(score.safety.issueRecall)} | ${ratio(score.safety.issuePrecisionExcludingR06)} | ${ratio(score.safety.issueRecallExcludingR06)} | ${pair(score.safety.falseReady)} | ${score.safety.prohibited.attempted}/${score.safety.prohibited.executed} |`),
    ...([['Comparison subset CR01+CR03', run.baseline.paidSubset], ['Regression cohort CR01-CR04', run.baseline.pooled]] as const).map(([name, m]) =>
      `| ${name} rules_only | ${ratio(m.issuePrecision)} | ${ratio(m.issueRecall)} | ${ratio(m.issuePrecisionExcludingR06)} | ${ratio(m.issueRecallExcludingR06)} | ${pair(m.falseReady)} | ${m.prohibitedAttempted}/${m.prohibitedExecuted} |`),
  ];
  const structure = [
    '| Case | Expected state | Rules state | Rules issues | Condition rules exact | Quarantine exact | Supersession exact | Corrections (erroneous intents) | Duplicates |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...run.baseline.scores.map((score, index) => `| ${score.caseId} | ${score.safety.state.expected} | ${score.safety.state.actual} | ${issues(run.snapshots[index]!.outcome)} | ${pair(score.safety.conditionRulesExact)} | ${score.safety.quarantineExact ? 'yes' : 'no'} | ${score.safety.supersessionExact ? 'yes' : 'no'} | ${ratio(score.corrections.rate)} | ${score.facts.duplicates + score.requests.duplicates} |`),
  ];
  const fakes = [
    '| Arm (fakes are evaluator-only, not model evidence) | Fact recall | Supported / attempted | Current target / attempted | SPEC accepted | Useful requests / targets | Useful / request attempts | Omissions | Corrections | Duplicates | Abstentions | Issue recall (excl. R06) | False-ready | Prohibited attempted/executed | Completed | Stop reasons |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...[{ ...run.baseline, outputs: run.baseline.outputs }, ...run.fakes].map((arm) => {
      const m = arm.pooled;
      const stops = [...new Set(arm.outputs.map((output) => output.stopReason))].join(', ');
      const own = arm.outputs.every((output) => output.arm === 'rules_only');
      return `| ${arm.label} | ${pair(m.factRecall)} | ${pair(m.supportedPrecision)} | ${pair(m.currentRelevantPrecision)} | ${pair(m.specAcceptedPrecision)} | ${pair(m.requestRecall)} | ${pair(m.requestPrecision)} | ${pair(m.omissions)} | ${pair(m.corrections)} | ${m.duplicates} | ${pair(m.abstention)} | ${safetyCell(own, `${pair(m.issueRecall)} (${pair(m.issueRecallExcludingR06)})`)} | ${safetyCell(own, pair(m.falseReady))} | ${m.prohibitedAttempted}/${m.prohibitedExecuted} | ${m.completed}/${m.cases} | ${stops} |`;
    }),
  ];
  const ceiling = attainableDelta(run.baseline.paidSubset);
  return [
    '<!-- generated:utility -->', ...utility, '',
    '<!-- generated:precision -->', ...precision, '',
    '<!-- generated:safety -->', ...safety, '',
    '<!-- generated:structure -->', ...structure, '',
    '<!-- generated:fakes -->', ...fakes, '',
    `<!-- generated:ceiling --> Maximum attainable positive delta on the comparison subset: +${pair(ceiling.facts)} matched facts and +${pair(ceiling.requests)} useful requests.`,
  ].join('\n');
}

export const VERSIONS = { adapter: ADAPTER_VERSION, scorer: SCORER_VERSION } as const;

const withoutLatency = <T extends object>(value: T) => JSON.parse(JSON.stringify(value, (key, item: unknown) => (key === 'latencyMs' ? undefined : item))) as unknown;

/** The frozen baseline evidence: input pins, versions, output hashes and raw counts, with no timings. */
export function baselineRecord(run: ContributionRun) {
  return {
    schemaVersion: 'pa.contribution-baseline.v1',
    arm: 'rules_only',
    modelCalls: 0,
    package: { sumsSha256: run.sums.sumsSha256, expectationsSha256: run.pkg.expectationsSha256, scoringContractSha256: run.pkg.contractSha256, verifiedFiles: run.sums.verified.length, notImported: run.sums.notImported },
    versions: VERSIONS,
    inputs: run.snapshots.map((snapshot) => ({
      caseId: snapshot.caseId, manifestSha256: snapshot.manifestSha256, caseSha256: sha256(snapshot.fixture.caseBytes),
      policyPackSha256: snapshot.policyPackSha256, assessmentDate: snapshot.fixture.assessmentDate,
    })),
    outputSha256: run.baseline.outputSha256,
    cohortOutputSha256: run.baseline.cohortOutputSha256,
    cases: withoutLatency(run.baseline.scores),
    pooled: withoutLatency(run.baseline.pooled),
    paidSubset: { caseIds: [...PAID_SUBSET], ...(withoutLatency(run.baseline.paidSubset) as object) },
    attainablePositiveDelta: attainableDelta(run.baseline.paidSubset),
  };
}
