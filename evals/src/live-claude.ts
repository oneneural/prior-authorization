import { join } from 'node:path';

import {
  ACCOUNTING_POLICY, createAnthropicProvider, LIVE_TOOLS_VERSION, OPUS_5_5_PRICE_SNAPSHOT, PROMPT_VERSION, unitsToUsd,
  type AdmissionPort, type LiveCall, type LiveClientFactory, type LiveProvider, type LiveSettings,
} from '@pa/agents';
import type { BudgetRunSummary } from '@pa/contracts';

import {
  AGENT_SUITE_ROOT, type CaseRun, GROUP_LABEL, GROUPS, loadExpectations, median, modeMetrics, ratio, runSnapshots, runSuiteCase,
} from './agent-comparison.js';
import { REPO_ROOT } from './v2/files.js';

// One bounded live Claude run over a critical subset, scored with the
// agent-comparison gates and expectations, rules_only alongside. The report is
// content-free: tool names, outcomes, hashes, usage and costs, never document
// bodies, model text or reasoning.

/** Held-out and adversarial pa-agent cases, then frozen v2 critical snapshots. */
export const LIVE_SUITE_CASES = ['H01', 'H02', 'H03', 'H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'F17a', 'F17b', 'F18a', 'F18d', 'F21a'] as const;
export const LIVE_SNAPSHOTS = ['F01', 'F02', 'F08a', 'F23', 'F09a', 'F13x3', 'F16a', 'F26a'] as const;

export interface LiveCaseRun extends CaseRun { calls: LiveCall[] }

export interface LiveEvaluationInput {
  settings: LiveSettings;
  /** Attempt admission for one registered budget run, shared by every case. */
  admission: AdmissionPort;
  clientFactory: LiveClientFactory;
  /** Case IDs to run, in subset order; defaults to the whole subset. */
  cases?: readonly string[];
  repoRoot?: string;
}

export async function runLiveEvaluation(input: LiveEvaluationInput): Promise<LiveCaseRun[]> {
  const repoRoot = input.repoRoot ?? REPO_ROOT;
  const wanted = new Set(input.cases ?? [...LIVE_SUITE_CASES, ...LIVE_SNAPSHOTS]);
  const unknown = [...wanted].filter((id) => !(LIVE_SUITE_CASES as readonly string[]).includes(id) && !(LIVE_SNAPSHOTS as readonly string[]).includes(id));
  if (unknown.length > 0) throw new Error(`not in the live subset: ${unknown.join(', ')}`);
  const providers = new Map<string, LiveProvider>();
  const providerFor = (caseId: string) => {
    const provider = createAnthropicProvider(input.settings, { admission: input.admission, clientFactory: input.clientFactory });
    providers.set(caseId, provider);
    return provider;
  };
  const runs: CaseRun[] = [];
  const expectations = await loadExpectations(join(repoRoot, AGENT_SUITE_ROOT, 'expectations'));
  for (const caseId of LIVE_SUITE_CASES.filter((id) => wanted.has(id))) {
    const expectation = expectations.find((item) => item.caseId === caseId);
    if (expectation === undefined) throw new Error(`${caseId}: no expectation`);
    runs.push(await runSuiteCase(expectation, repoRoot, providerFor(caseId)));
  }
  const fixtureIds = LIVE_SNAPSHOTS.filter((id) => wanted.has(id));
  if (fixtureIds.length > 0) {
    const snapshots = await runSnapshots(repoRoot, { fixtureIds, provider: providerFor });
    runs.push(...snapshots.runs);
  }
  // An attempt abandoned at a case's time limit must finish its accounting before the report.
  await Promise.all([...providers.values()].map((provider) => provider.settle()));
  return runs.map((run) => ({ ...run, calls: [...(providers.get(run.caseId)?.calls ?? [])] }));
}

/** A call's committed cost in units: its reconciled actual, nothing once released, otherwise the held reservation. */
export const callCostUnits = (call: LiveCall) => call.actualUnits ?? (call.attemptState === 'released' ? 0 : call.reservedUnits);

const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
const usd = (value: number) => `$${value.toFixed(4)}`;

/** Provider-side counts over every call: outcomes, tokens, cost and latency. */
export function liveMetrics(runs: readonly LiveCaseRun[]) {
  const calls = runs.flatMap((run) => run.calls);
  const graphRuns = runs.filter((run) => run.graph.outcome !== 'not_run');
  const count = (outcome: LiveCall['outcome']) => calls.filter((call) => call.outcome === outcome).length;
  const failed = new Set<LiveCall['outcome']>(['refusal', 'max_tokens', 'unexpected_stop']);
  const toolSteps = graphRuns.flatMap((run) => run.graph.trace.filter((step) => step.kind === 'tool'));
  return {
    calls: calls.length,
    outcomes: Object.fromEntries((['tool_use', 'finish', 'refusal', 'max_tokens', 'unexpected_stop', 'api_error', 'budget_refused', 'admission_refused', 'admission_unavailable'] as const).map((outcome) => [outcome, count(outcome)])),
    refusals: [count('refusal'), calls.length] as const,
    refusalCategories: calls.filter((call) => call.outcome === 'refusal').map((call) => call.refusalCategory ?? 'none'),
    // Invalid output the provider did not already explain as a refusal, truncation or unexpected stop.
    invalidOutputs: [graphRuns.filter((run) => run.graph.stopReason === 'invalid_model_output' && !run.calls.some((call) => failed.has(call.outcome))).length, graphRuns.length] as const,
    invalidToolInputs: [toolSteps.filter((step) => step.outcome === 'invalid_input').length, toolSteps.length] as const,
    tokens: {
      input: sum(calls.map((call) => call.usage?.inputTokens ?? 0)),
      cacheWrite: sum(calls.map((call) => call.usage?.cacheCreationInputTokens ?? 0)),
      cacheRead: sum(calls.map((call) => call.usage?.cacheReadInputTokens ?? 0)),
      output: sum(calls.map((call) => call.usage?.outputTokens ?? 0)),
    },
    reconciledUsd: unitsToUsd(sum(calls.map((call) => call.actualUnits ?? 0))),
    /** Reservations kept because usage is unknown (API errors, missing usage). */
    heldUsd: unitsToUsd(sum(calls.filter((call) => call.actualUnits === null).map(callCostUnits))),
    modelLatencyMs: { total: sum(calls.map((call) => call.latencyMs)), median: median(calls.filter((call) => call.usage !== null).map((call) => call.latencyMs)) },
  };
}

export interface LiveReportContext {
  runId: string;
  label: string;
  settings: LiveSettings;
  revision: string;
  dirtyPaths: number;
  startedAt: string;
  finishedAt: string;
  /** The API's canonical-ledger summary for this run after it was stopped. */
  ledger: BudgetRunSummary;
  promptNote: string;
}

/** `pa.live-eval-report.v2`: the committed, content-free record of one live run, with ledger figures from the API. */
export function buildLiveReport(runs: readonly LiveCaseRun[], context: LiveReportContext) {
  const metric = (mode: 'rules' | 'graph', subset: readonly LiveCaseRun[]) => {
    const m = modeMetrics(subset, mode);
    return {
      cases: m.cases, issuePrecision: m.issuePrecision, issueRecall: m.issueRecall, supportedEvidence: m.supportedEvidence, abstentions: m.abstentions,
      notRun: m.notRun, prohibitedAttemptedExecuted: m.prohibited, falseReady: m.falseReady, latencyMs: m.latencyMs, matchesRules: m.matchesRules,
    };
  };
  const byGroup = GROUPS.filter((group) => runs.some((run) => run.group === group)).map((group) => {
    const subset = runs.filter((run) => run.group === group);
    return { group, rules: metric('rules', subset), live: metric('graph', subset), provider: liveMetrics(subset) };
  });
  return {
    schemaVersion: 'pa.live-eval-report.v2',
    label: 'live_claude',
    runLabel: context.label,
    runId: context.runId,
    revision: context.revision,
    uncommittedPaths: context.dirtyPaths,
    startedAt: context.startedAt,
    finishedAt: context.finishedAt,
    model: context.settings.model,
    effort: context.settings.effort,
    maxOutputTokens: context.settings.maxOutputTokens,
    thinking: 'adaptive (parameter omitted; display omitted)',
    toolChoice: 'auto, parallel tool use disabled, strict tools',
    serverSideFallbacks: 'none',
    promptVersion: PROMPT_VERSION,
    toolsVersion: LIVE_TOOLS_VERSION,
    promptNote: context.promptNote,
    priceSnapshot: OPUS_5_5_PRICE_SNAPSHOT,
    caps: { runUsd: unitsToUsd(context.ledger.capUnits), dailyUsd: unitsToUsd(ACCOUNTING_POLICY.caps.dayUnits), totalUsd: unitsToUsd(ACCOUNTING_POLICY.caps.lifetimeUnits) },
    ledger: {
      runCalls: context.ledger.attempts,
      runCommittedUsd: unitsToUsd(context.ledger.runCommittedUnits),
      dayCommittedUsd: unitsToUsd(context.ledger.dayCommittedUnits),
      totalCommittedUsd: unitsToUsd(context.ledger.lifetimeCommittedUnits),
      heldUsd: unitsToUsd(context.ledger.heldUnits),
    },
    totals: { rules: metric('rules', runs), live: metric('graph', runs), provider: liveMetrics(runs) },
    identicalIssues: [
      runs.filter((run) => run.graph.outcome !== 'not_run' && JSON.stringify(run.graph.issues) === JSON.stringify(run.rules.issues)).length,
      runs.filter((run) => run.graph.outcome !== 'not_run').length,
    ] as const,
    byGroup,
    cases: runs.map((run) => ({
      caseId: run.caseId, group: run.group,
      expected: run.expected.outcome === 'assessed' ? { state: run.expected.state, issues: run.expected.issues } : { outcome: 'rejected' },
      rules: { state: run.rules.state ?? run.rules.outcome, issues: run.rules.issues, latencyMs: run.rules.latencyMs },
      live: {
        stopReason: run.graph.stopReason, issues: run.graph.issues, evidence: run.graph.evidence, supported: run.graph.supported,
        proposalCodes: run.graph.proposals.map((proposal) => `${proposal.kind}:${proposal.code ?? 'valid'}`),
        prohibitedAttempts: run.graph.prohibitedAttempts, prohibitedExecuted: run.graph.prohibitedExecuted, toolErrors: run.graph.toolErrors, latencyMs: run.graph.latencyMs,
        trace: run.graph.trace,
        calls: run.calls,
        costUsd: unitsToUsd(sum(run.calls.map(callCostUnits))),
      },
      gateProblems: run.problems,
      behaviorNotes: run.notes ?? [],
    })),
  };
}
export type LiveReport = ReturnType<typeof buildLiveReport>;

/** Problems that fail the live command: any gate problem, or a case the provider could not serve (API error, budget or admission refusal). */
export function liveRunFailures(report: LiveReport): string[] {
  return report.cases.flatMap((item) => [
    ...item.gateProblems.map((problem) => `${item.caseId}: ${problem}`),
    ...(item.live.stopReason === 'provider_unavailable' ? [`${item.caseId}: stopped as provider_unavailable`] : []),
  ]);
}

const pair = ([numerator, denominator]: readonly [number, number]) => ratio(numerator, denominator);

export function formatLiveReport(report: LiveReport): string {
  const p = report.totals.provider;
  const lines = [
    `# Live Claude evaluation (${report.runLabel})`,
    '',
    `Label \`live_claude\`. Model \`${report.model}\`, effort \`${report.effort}\`, max output ${report.maxOutputTokens} tokens, ${report.thinking}; ${report.toolChoice}; server-side fallbacks: ${report.serverSideFallbacks}.`,
    `Revision \`${report.revision}\`${report.uncommittedPaths > 0 ? ` with ${report.uncommittedPaths} uncommitted path(s)` : ''}. Run \`${report.runId}\`, ${report.startedAt} to ${report.finishedAt}.`,
    `Prompt \`${report.promptVersion}\`, tools \`${report.toolsVersion}\`. ${report.promptNote}`,
    `Prices (USD per million tokens, ${report.priceSnapshot.source}, read ${report.priceSnapshot.readOn}): input ${report.priceSnapshot.usdPerMTok.inputPerMTok}, 5-minute cache write ${report.priceSnapshot.usdPerMTok.cacheWritePerMTok}, cache read ${report.priceSnapshot.usdPerMTok.cacheReadPerMTok}, output ${report.priceSnapshot.usdPerMTok.outputPerMTok}.`,
    `Caps: run ${usd(report.caps.runUsd)}, day ${usd(report.caps.dailyUsd)}, total ${usd(report.caps.totalUsd)}. Canonical ledger after the run: this run ${usd(report.ledger.runCommittedUsd)} over ${report.ledger.runCalls} attempt(s), ${usd(report.ledger.heldUsd)} held; UTC day ${usd(report.ledger.dayCommittedUsd)}; all runs ${usd(report.ledger.totalCommittedUsd)}.`,
    '',
    'Synthetic inputs only. Administrative readiness only: no clinical validity, payer authorization or payment claim. The graph cannot change the deterministic state; the live model only reads and proposes, and the evaluator gate checks every proposal.',
    '',
    '| Group | Mode | Cases | Issue precision | Issue recall | Supported evidence | Abstentions | Prohibited attempted/executed | False-ready | Latency total / median ms |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  const row = (label: string, mode: string, m: LiveReport['totals']['rules']) =>
    `| ${label} | ${mode} | ${m.cases} | ${pair(m.issuePrecision)} | ${pair(m.issueRecall)} | ${pair(m.supportedEvidence)} | ${pair(m.abstentions)}${m.notRun > 0 ? `, ${m.notRun} not run` : ''} | ${m.prohibitedAttemptedExecuted[0]}/${m.prohibitedAttemptedExecuted[1]} | ${pair(m.falseReady)} | ${m.latencyMs.total.toFixed(0)} / ${m.latencyMs.median.toFixed(0)} |`;
  for (const group of report.byGroup) {
    lines.push(row(GROUP_LABEL[group.group], 'rules_only', group.rules), row(GROUP_LABEL[group.group], 'live_claude graph', group.live));
  }
  lines.push(row('all', 'rules_only', report.totals.rules), row('all', 'live_claude graph', report.totals.live));
  lines.push(
    '',
    `Provider calls: ${p.calls} (${Object.entries(p.outcomes).map(([key, value]) => `${key} ${value}`).join(', ')}). Refusals ${pair(p.refusals)}${p.refusalCategories.length > 0 ? ` (categories: ${p.refusalCategories.join(', ')})` : ''}. Invalid model outputs ${pair(p.invalidOutputs)} runs; invalid tool inputs ${pair(p.invalidToolInputs)} tool steps.`,
    `Tokens: input ${p.tokens.input}, cache write ${p.tokens.cacheWrite}, cache read ${p.tokens.cacheRead}, output ${p.tokens.output}. Cost: ${usd(p.reconciledUsd)} reconciled from reported usage${p.heldUsd > 0 ? `, plus ${usd(p.heldUsd)} held as reservations with unknown usage` : ''}. Model latency total ${(p.modelLatencyMs.total / 1000).toFixed(1)} s, median ${(p.modelLatencyMs.median / 1000).toFixed(1)} s per call.`,
    `Gate-accepted fact proposals matching a deterministic extraction: ${pair(report.totals.live.matchesRules)}. Live issue sets equal rules_only in ${pair(report.identicalIssues)} graph runs: the graph cannot change state, and its issue set is the rules issues plus any finding a gate-accepted request names.`,
    '',
    '| Case | Group | Expected | Rules | Live stop | Calls | Proposal codes | Prohibited | Tokens in/out | Cost USD | Latency s | Gates |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...report.cases.map((item) => {
      const tokensIn = sum(item.live.calls.map((call) => (call.usage?.inputTokens ?? 0) + (call.usage?.cacheCreationInputTokens ?? 0) + (call.usage?.cacheReadInputTokens ?? 0)));
      const tokensOut = sum(item.live.calls.map((call) => call.usage?.outputTokens ?? 0));
      const expected = 'state' in item.expected ? item.expected.state : 'rejected';
      return `| ${item.caseId} | ${item.group} | ${expected} | ${item.rules.state} | ${item.live.stopReason ?? 'not run'} | ${item.live.calls.map((call) => call.outcome === 'tool_use' ? call.tool : call.outcome).join(' > ') || 'none'} | ${item.live.proposalCodes.join(', ') || 'none'} | ${item.live.prohibitedAttempts}/${item.live.prohibitedExecuted} | ${tokensIn}/${tokensOut} | ${item.live.costUsd.toFixed(4)} | ${(item.live.latencyMs / 1000).toFixed(1)} | ${item.gateProblems.length === 0 ? 'PASS' : 'FAIL'} |`;
    }),
    '',
    'Gate problems (prohibited execution, unsupported accepted evidence, changed state, false-ready, rules mismatch):',
    ...(report.cases.some((item) => item.gateProblems.length > 0) ? report.cases.flatMap((item) => item.gateProblems.map((problem) => `- ${item.caseId}: ${problem}`)) : ['- none']),
    '',
    'Behavior differences from the authored scripted-provider expectations (reported, not gating):',
    ...(report.cases.some((item) => item.behaviorNotes.length > 0) ? report.cases.flatMap((item) => item.behaviorNotes.map((note) => `- ${item.caseId}: ${note}`)) : ['- none']),
    '',
    'Limits: one run of a small synthetic sample, so no rate is a stable estimate; fixtures, expectations and gates share one synthetic authoring lineage; the evaluator port mirrors, but is not, the API gate; the request declares only the allowlisted tools, with strict schemas, so prohibited attempts measure tool choice within that surface; no clinical, payer or production validity.',
  );
  return lines.join('\n');
}
