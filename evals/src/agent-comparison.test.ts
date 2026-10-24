import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { AssessmentOutcomeV3 } from '@pa/contracts';
import { assessV2 } from '@pa/domain';

import {
  type AgentExpectation, type CaseRun, EvaluatorPort, graphMode, issuesOf, loadExpectations, modeMetrics, runSuiteCase, scriptedReader, unavailableProvider,
} from './agent-comparison.js';
import { REPO_ROOT } from './v2/files.js';
import { loadFixture } from './v2/loader.js';
import { V2_SUITE_ROOT } from './v2/schemas.js';

async function f01() {
  const load = await loadFixture(join(REPO_ROOT, V2_SUITE_ROOT), 'F01');
  if (load.outcome !== 'loaded') throw new Error('F01 did not load');
  const { fixture } = load;
  const outcome = AssessmentOutcomeV3.parse(await assessV2({
    caseBytes: fixture.caseBytes, documents: fixture.documents, policyPackBytes: await readFile(join(REPO_ROOT, fixture.policyInputPath)), assessmentDate: fixture.assessmentDate,
  }));
  if (outcome.outcome !== 'assessed') throw new Error('F01 was not assessed');
  return { fixture, outcome };
}

describe('pa-agent suite', () => {
  it('holds at least eight held-out mutations, the F17/F18/F21 rows and four scripted provider failures', async () => {
    const expectations = await loadExpectations();
    const holdouts = expectations.filter((item) => item.group === 'holdout');
    expect(holdouts.length).toBeGreaterThanOrEqual(8);
    expect(new Set(holdouts.flatMap((item) => item.fixture.suite === 'pa-agent' ? [item.fixture.fixtureId] : [])).size).toBe(holdouts.length);
    expect(new Set(expectations.filter((item) => item.group === 'adversarial').map((item) => item.specRow))).toEqual(new Set(['F17', 'F18', 'F21']));
    expect(expectations.filter((item) => item.group === 'failure').map((item) => item.provider.kind === 'recorded' ? item.provider.responseId : item.provider.kind).sort())
      .toEqual(['fail-invalid', 'fail-refusal', 'fail-truncated', 'unavailable']);
  });

  // A path to the suite, the bare suite name as a string literal, or this module.
  const SUITE_REFERENCE = /suites[\\/]+pa-agent|(['"`])pa-agent\1|agent-comparison/;

  it('no runtime file under packages/ or apps/ names the pa-agent suite', async () => {
    const offenders: string[] = [];
    const walk = async (dir: string) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory() && !['node_modules', 'dist', '.next'].includes(entry.name)) await walk(path);
        else if (entry.isFile() && SUITE_REFERENCE.test(await readFile(path, 'latin1'))) offenders.push(relative(REPO_ROOT, path).split(sep).join('/'));
      }
    };
    await walk(join(REPO_ROOT, 'packages'));
    await walk(join(REPO_ROOT, 'apps'));
    expect(offenders).toEqual([]);
  });

  it('reports a wrong expectation as a mismatch instead of passing it', async () => {
    const expectation = (await loadExpectations()).find((item) => item.caseId === 'F21a')!;
    const wrong: AgentExpectation = {
      ...expectation,
      expected: { ...expectation.expected, state: 'ready_for_review', agent: { ...expectation.expected.agent, proposalCodes: ['valid'], prohibitedAttempts: 0 } },
    };
    const run = await runSuiteCase(wrong);
    expect(run.problems).toEqual(expect.arrayContaining([
      'rules state: got needs_information, expected ready_for_review',
      expect.stringMatching(/^proposal codes: got \[invalid_schema, invalid_schema, request_not_applicable, valid\]/),
      'prohibited attempts: got 1, expected 0',
    ]));
  });
});

describe('evaluator port and scripted graph', () => {
  it('applies the API proposal checks to fact and request candidates', async () => {
    const { fixture, outcome } = await f01();
    const binding = { expectedRevision: 1, sourceRevisionHash: 'a'.repeat(64), policyPackSha256: 'b'.repeat(64), packetHash: 'c'.repeat(64) };
    const port = new EvaluatorPort(fixture, outcome, binding);
    const order = { field: 'order.date', documentId: 'f01-order', documentVersion: 1, locator: '/orderDate', value: '2026-09-02', originalText: '2026-09-02', confidence: 0.9, sourceContentHash: '60668dad9d3a1404bc577b652aaeefef03cf608df0ec40c7dba76d577505db76' };
    const codes = [];
    for (const [index, candidate] of [order, { ...order, value: '2026-09-03', originalText: '2026-09-03' }, { ...order, confidence: 0.69 }, { ...order, documentVersion: 9 }].entries()) {
      codes.push((await port.propose({ proposalKey: `k${index}`, kind: 'fact', candidate })).data.code);
    }
    codes.push((await port.propose({ proposalKey: 'r0', kind: 'request', candidate: { findingId: 'finding-R03', templateId: 'existing_order', recipientRole: 'practitioner_records' } })).data.code);
    expect(codes).toEqual([null, 'value_mismatch', 'low_confidence', 'source_unavailable', 'request_not_applicable']);
    // A repeated key returns the first result without recording a second proposal.
    expect((await port.propose({ proposalKey: 'k1', kind: 'fact', candidate: order })).data.code).toBe('value_mismatch');
    expect(port.proposals).toHaveLength(5);
    await expect(port.readDocument('f02-encounter', 1)).rejects.toMatchObject({ permanent: true, status: 404 });
  });

  it('runs the scripted reader through the graph with only supported, gate-accepted facts', async () => {
    const { fixture, outcome } = await f01();
    const run = await graphMode(fixture, outcome, scriptedReader());
    expect(run.stopReason).toBe('finished');
    expect(run.state).toBe(outcome.result.state);
    expect(run.issues).toEqual(issuesOf(outcome.result.findings));
    expect(run.evidence).toBe(10);
    expect(run.supported).toBe(10);
    expect(run.prohibitedAttempts).toBe(0);
    expect(run.modelCalls).toBe(6);
  });

  it('records an unreachable provider as an abstention with no proposal', async () => {
    const { fixture, outcome } = await f01();
    const run = await graphMode(fixture, outcome, unavailableProvider());
    expect(run.stopReason).toBe('provider_unavailable');
    expect(run.proposals).toEqual([]);
    expect(run.state).toBe(outcome.result.state);
  });
});

describe('mode metrics', () => {
  const mode = (state: string, issues: string[]) => ({ outcome: 'assessed' as const, state, issues, evidence: 2, supported: 2, latencyMs: 1 });
  const run = (expectedState: string, expectedIssues: string[], rules: ReturnType<typeof mode>): CaseRun => ({
    caseId: 'x', group: 'snapshot', expected: { outcome: 'assessed', state: expectedState, issues: expectedIssues }, rules,
    graph: { ...rules, stopReason: 'finished', trace: [], proposals: [], prohibitedAttempts: 0, prohibitedExecuted: 0, toolErrors: 0, modelCalls: 1, matchesRules: 0 },
    problems: [],
  });

  it('counts issue precision and recall and false-ready with numerators and denominators', () => {
    const metrics = modeMetrics([
      run('needs_information', ['R03:missing', 'R06:manual_review'], mode('ready_for_review', ['R06:manual_review'])),
      run('ready_for_review', ['R06:manual_review'], mode('ready_for_review', ['R06:manual_review', 'R04:conflict'])),
    ], 'rules');
    expect(metrics.issuePrecision).toEqual([2, 3]);
    expect(metrics.issueRecall).toEqual([2, 3]);
    expect(metrics.falseReady).toEqual([1, 1]);
    expect(metrics.supportedEvidence).toEqual([4, 4]);
  });
});
