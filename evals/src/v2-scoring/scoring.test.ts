import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type AssessmentOutcomeV3 } from '@pa/contracts';
import { assessV2 } from '@pa/domain';
import { describe, expect, it, vi } from 'vitest';

import { V2_BATCHES } from '../v2-batches.js';
import { nodeFileSystem, REPO_ROOT } from '../v2/files.js';
import { loadFixture } from '../v2/loader.js';
import { OracleV3, V2_SUITE_ROOT } from '../v2/schemas.js';
import { compareV2, falseReadyV2, reportV2, runAssessmentV2, type V2Evaluation } from './scoring.js';

async function example(fixtureId: string) {
  const suite = join(REPO_ROOT, V2_SUITE_ROOT);
  const oracle = OracleV3.parse(JSON.parse(await readFile(join(suite, 'oracles', `${fixtureId}.json`), 'utf8')));
  const load = await loadFixture(suite, fixtureId);
  if (load.outcome !== 'loaded') throw new Error('example must load');
  const actual = await assessV2({
    caseBytes: load.fixture.caseBytes,
    documents: load.fixture.documents,
    assessmentDate: load.fixture.assessmentDate,
    policyPackBytes: await readFile(join(REPO_ROOT, load.fixture.policyInputPath)),
  });
  return { oracle, actual };
}

describe('v2 complete comparison', () => {
  it('matches the assessed snapshot, including exact source text and deferred expectations', async () => {
    for (const id of ['F01', 'F01x1', 'F26a']) {
      const { actual, oracle } = await example(id);
      expect(compareV2(actual, oracle)).toEqual([]);
    }
  });

  it('compares complete finding, citation, condition and document sets', async () => {
    const { actual, oracle } = await example('F01');
    if (actual.outcome !== 'assessed' || oracle.expectation.outcome !== 'assessed') throw new Error('example must assess');
    const expected = structuredClone(oracle);
    if (expected.expectation.outcome !== 'assessed') throw new Error('example must assess');
    expected.expectation.state = 'needs_information';
    expected.expectation.clinicalReviewRequired = false;
    expected.expectation.quarantinedDocuments = [{ documentId: 'other', version: 1 }];
    expected.expectation.supersededDocuments = [{ documentId: 'other', version: 2 }];
    expected.expectation.findings = expected.expectation.findings.filter((finding) => finding.ruleId !== 'R08');
    const finding = expected.expectation.findings.find((entry) => entry.ruleId === 'R03')!;
    finding.status = 'missing';
    finding.responsibleRole = 'authorization_coordinator';
    finding.affectedDocuments = [{ documentId: 'other', version: 1 }];
    finding.citations = [];
    finding.conditions = [{ conditionKey: 'R03.element_missing', field: 'element.signature', documents: [{ documentId: 'other', version: 1 }] }];
    const problems = compareV2(actual, expected).join('\n');
    for (const label of ['state', 'clinicalReviewRequired', 'quarantined documents', 'superseded documents', 'findings by rule', 'R03 status', 'R03 role', 'R03 affected documents', 'R03 citations', 'R03 conditions']) {
      expect(problems).toContain(`${label}:`);
    }
  });

  it('treats order within comparison sets as irrelevant', async () => {
    const { actual, oracle } = await example('F01');
    if (oracle.expectation.outcome !== 'assessed') throw new Error('example must assess');
    oracle.expectation.findings.reverse();
    oracle.expectation.findings.forEach((finding) => {
      finding.citations.reverse();
      finding.conditions.reverse();
      finding.affectedDocuments.reverse();
      finding.conditions.forEach((condition) => condition.documents.reverse());
    });
    expect(compareV2(actual, oracle)).toEqual([]);
  });

  it('requires exact text on a cited fact, including the numeric token', async () => {
    const { actual, oracle } = await example('F01x1');
    if (oracle.expectation.outcome !== 'assessed') throw new Error('example must assess');
    const numeric = oracle.expectation.exactText?.find((entry) => entry.locator === '/item/quantity');
    if (numeric === undefined) throw new Error('example must have exact text');
    numeric.originalText = '1';
    expect(compareV2(actual, oracle)).toEqual([expect.stringContaining('exactText')]);
  });

  it('matches rejection stage and all canonical reasons exactly', async () => {
    const oracle = OracleV3.parse(JSON.parse(await readFile(join(REPO_ROOT, V2_SUITE_ROOT, 'oracles/F26j.json'), 'utf8')));
    const load = await loadFixture(join(REPO_ROOT, V2_SUITE_ROOT), 'F26j');
    if (load.outcome !== 'rejected' || oracle.expectation.outcome !== 'rejected') throw new Error('example must reject');
    const actual: AssessmentOutcomeV3 = { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'rejected', rejection: load.rejection };
    expect(compareV2(actual, oracle)).toEqual([]);
    oracle.expectation.reasons[0]!.path = '/documents/other/payload';
    expect(compareV2(actual, oracle)).toEqual([expect.stringContaining('rejection reasons:')]);
    oracle.expectation.stage = 'schema';
    expect(compareV2(actual, oracle).join('\n')).toContain('rejection stage:');
    const assessed = await example('F01');
    expect(compareV2(actual, assessed.oracle)).toEqual([expect.stringContaining('outcome:')]);
  });
});

describe('v2 run completeness', () => {
  it('excludes expected rejections from false-ready and exposes refused or missing results', async () => {
    const { actual, oracle } = await example('F01');
    if (oracle.expectation.outcome !== 'assessed') throw new Error('example must assess');
    oracle.expectation.state = 'needs_information';
    const blocked: V2Evaluation = { fixtureId: 'blocked', expected: oracle.expectation, actual, problems: ['state mismatch'] };
    const rejected = { outcome: 'rejected' as const, stage: 'schema' as const, reasons: [{ code: 'case_invalid' as const, documentRef: null, path: '/case' }] };
    const rejection: V2Evaluation = { fixtureId: 'rejected', expected: rejected, actual: { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'rejected', rejection: { schemaVersion: 'pa.input-rejection.v1', stage: rejected.stage, reasons: rejected.reasons } }, problems: [] };
    expect(falseReadyV2([blocked, rejection])).toEqual({ numerator: 1, denominator: 1, fixtureIds: ['blocked'], complete: true });
    const unfinished: V2Evaluation = { ...blocked, fixtureId: 'unfinished', actual: undefined };
    expect(reportV2([blocked, rejection, unfinished]).report).toContain('False-ready: INCOMPLETE');
    expect(falseReadyV2([], [])).toMatchObject({ complete: false });
    expect(falseReadyV2([blocked], ['inventory missing'])).toMatchObject({ complete: false });
  });

  it('refuses a failed pin check before invoking the assessment and prints every row', async () => {
    const assessor = vi.fn(assessV2);
    const fs = { ...nodeFileSystem, readFile: async (path: string) => path.endsWith('/oracles/F01.json') ? Buffer.from('{}') : nodeFileSystem.readFile(path) };
    const run = await runAssessmentV2(V2_BATCHES, REPO_ROOT, fs, assessor);
    expect(assessor).not.toHaveBeenCalled();
    expect(run.exitCode).toBe(1);
    expect(run.counts).toMatchObject({ refused: 95, matched: 0 });
    expect(run.falseReady.complete).toBe(false);
    expect(run.report.match(/^\| F/gm)).toHaveLength(96); // Header plus 95 fixtures.
  });

  it('cannot count a thrown assessment as a matching expected rejection', async () => {
    const assessor = vi.fn<typeof assessV2>().mockRejectedValue(new Error('execution failed'));
    const run = await runAssessmentV2(V2_BATCHES, REPO_ROOT, nodeFileSystem, assessor);
    expect(run.exitCode).toBe(1);
    expect(run.counts.refused).toBeGreaterThan(0);
    expect(run.falseReady.complete).toBe(false);
    expect(run.evaluations.find((evaluation) => evaluation.fixtureId === 'F01')?.problems).toEqual(['refused: fixture read or assessment did not complete']);
  });
});
