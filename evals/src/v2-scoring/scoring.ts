import { join } from 'node:path';

import { AssessmentOutcomeV3, type DocumentRef } from '@pa/contracts';
import { assessV2 } from '@pa/domain';

import { V2_BATCHES } from '../v2-batches.js';
import { runOraclesV2 } from '../v2/command.js';
import { decodeUtf8, type FileSystem, nodeFileSystem, REPO_ROOT } from '../v2/files.js';
import { scanJson } from '../v2/json-scan.js';
import { loadFixture } from '../v2/loader.js';
import { FrozenBatchSchema, OracleV3, V2_SUITE_ROOT } from '../v2/schemas.js';

type Expectation = OracleV3['expectation'];

export interface V2Evaluation {
  fixtureId: string;
  expected: Expectation | undefined;
  /** Undefined means refused or unfinished, never a successful rejection. */
  actual: AssessmentOutcomeV3 | undefined;
  problems: string[];
}

const refKey = (ref: DocumentRef) => JSON.stringify([ref.documentId, ref.version]);
const citationKey = (citation: { documentId: string; documentVersion: number; locator: string }) =>
  JSON.stringify([citation.documentId, citation.documentVersion, citation.locator]);
const brief = (value: unknown) => {
  const text = JSON.stringify(value);
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
};

/** Compare only the frozen expectations. Deferred behavior is never scored. */
export function compareV2(actual: AssessmentOutcomeV3, oracle: OracleV3): string[] {
  const parsed = AssessmentOutcomeV3.safeParse(actual);
  if (!parsed.success) {
    return parsed.error.issues.map((issue) => `contract: ${issue.path.map(String).join('.')}: ${issue.message}`);
  }
  const expected = oracle.expectation;
  const problems: string[] = [];
  const equal = (got: unknown, want: unknown, label: string) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      problems.push(`${label}: got ${brief(got)}, expected ${brief(want)}`);
    }
  };
  const sameSet = (got: string[], want: string[], label: string) => {
    equal([...got].sort(), [...want].sort(), label);
    if (new Set(got).size !== got.length) {
      problems.push(`${label}: duplicate entries`);
    }
  };

  equal(actual.outcome, expected.outcome, 'outcome');
  if (actual.outcome === 'rejected' && expected.outcome === 'rejected') {
    equal(actual.rejection.stage, expected.stage, 'rejection stage');
    // Property order is irrelevant; reason order, nulls and all values are exact.
    const reasons = (entries: typeof expected.reasons) => entries.map((reason) => [reason.code, reason.documentRef === null ? null : refKey(reason.documentRef), reason.path]);
    equal(reasons(actual.rejection.reasons), reasons(expected.reasons), 'rejection reasons');
  }
  if (actual.outcome !== 'assessed' || expected.outcome !== 'assessed') {
    return problems;
  }

  const result = actual.result;
  equal(result.policyPackId, oracle.policyInput.packId, 'policy pack ID');
  equal(result.policyPackSha256, oracle.policyInput.sha256, 'policy pack hash');
  equal(result.state, expected.state, 'state');
  equal(result.findings.find((finding) => finding.ruleId === 'R06')?.status === 'manual_review', expected.clinicalReviewRequired, 'clinicalReviewRequired');
  sameSet(result.quarantinedDocuments.map(refKey), expected.quarantinedDocuments.map(refKey), 'quarantined documents');
  sameSet(result.supersededDocuments.map(refKey), expected.supersededDocuments.map(refKey), 'superseded documents');
  sameSet(result.findings.map((finding) => finding.ruleId), expected.findings.map((finding) => finding.ruleId), 'findings by rule');

  const facts = new Map(result.evidenceFacts.map((fact) => [fact.factId, fact]));
  for (const want of expected.findings) {
    const got = result.findings.find((finding) => finding.ruleId === want.ruleId);
    if (got === undefined) {
      continue;
    }
    equal(got.status, want.status, `${want.ruleId} status`);
    equal(got.responsibleRole, want.responsibleRole, `${want.ruleId} role`);
    sameSet(got.documentRefs.map(refKey), want.affectedDocuments.map(refKey), `${want.ruleId} affected documents`);
    const condition = (key: string, field: string | null, documents: DocumentRef[]) => JSON.stringify([key, field, documents.map(refKey).sort()]);
    sameSet(
      got.conditions.map((entry) => condition(entry.conditionKey, entry.field, entry.documentRefs)),
      want.conditions.map((entry) => condition(entry.conditionKey, entry.field, entry.documents)),
      `${want.ruleId} conditions`,
    );
    sameSet(
      got.evidenceFactIds.map((id) => citationKey(facts.get(id)!)),
      want.citations.map(citationKey),
      `${want.ruleId} citations`,
    );
  }
  const citedIds = new Set(result.findings.flatMap((finding) => finding.evidenceFactIds));
  for (const entry of expected.exactText ?? []) {
    const cited = result.evidenceFacts.filter((fact) => citedIds.has(fact.factId) && citationKey(fact) === citationKey(entry));
    equal(cited.map((fact) => fact.originalText), [entry.originalText], `exactText ${citationKey(entry)}`);
  }
  return problems;
}

/** Expected rejections are excluded; unexpected rejections remain mismatches. */
export function falseReadyV2(evaluations: readonly V2Evaluation[], runProblems: readonly string[] = []) {
  const blocked = evaluations.filter((evaluation) => evaluation.expected?.outcome === 'assessed' && evaluation.expected.state !== 'ready_for_review');
  const ready = blocked.filter((evaluation) => evaluation.actual?.outcome === 'assessed' && evaluation.actual.result.state === 'ready_for_review');
  return {
    numerator: ready.length,
    denominator: blocked.length,
    fixtureIds: ready.map((evaluation) => evaluation.fixtureId),
    complete: evaluations.length > 0 && runProblems.length === 0 && evaluations.every((evaluation) => evaluation.expected !== undefined && evaluation.actual !== undefined),
  };
}

export function reportV2(evaluations: readonly V2Evaluation[], problems: readonly string[] = []) {
  const counts = {
    assessed: evaluations.filter((evaluation) => evaluation.actual?.outcome === 'assessed').length,
    rejected: evaluations.filter((evaluation) => evaluation.actual?.outcome === 'rejected').length,
    refused: evaluations.filter((evaluation) => evaluation.actual === undefined).length,
    matched: evaluations.filter((evaluation) => evaluation.actual !== undefined && evaluation.expected !== undefined && evaluation.problems.length === 0).length,
    deferred: evaluations.reduce((count, evaluation) => count + (evaluation.expected?.outcome === 'assessed' ? (evaluation.expected.deferredExpectations?.length ?? 0) : 0), 0),
  };
  const falseReady = falseReadyV2(evaluations, problems);
  const label = (value: Expectation | AssessmentOutcomeV3 | undefined) => {
    if (value === undefined) return 'refused / not run';
    if (value.outcome === 'assessed') return 'result' in value ? value.result.state : value.state;
    return `rejected:${'rejection' in value ? value.rejection.stage : value.stage}`;
  };
  const report = [
    'V2 frozen snapshot assessment: rules_only, no provider call. Administrative readiness only.',
    '| Fixture | Expected | Actual | Match |',
    '| --- | --- | --- | --- |',
    ...evaluations.map((evaluation) => `| ${evaluation.fixtureId} | ${label(evaluation.expected)} | ${label(evaluation.actual)} | ${evaluation.actual !== undefined && evaluation.expected !== undefined && evaluation.problems.length === 0 ? 'MATCH' : 'MISMATCH'} |`),
    `Totals: ${evaluations.length} registered; ${counts.assessed} assessed, ${counts.rejected} rejected, ${counts.refused} refused / not run; ${counts.matched} matched, ${evaluations.length - counts.matched} mismatched.`,
    `Deferred expectations: ${counts.deferred}, not scored or counted as passed.`,
    `False-ready: ${falseReady.complete ? '' : 'INCOMPLETE, partial counts only; '}${falseReady.numerator}/${falseReady.denominator} expected-assessed fixtures whose oracle state is not ready_for_review; expected rejections excluded.${falseReady.fixtureIds.length === 0 ? '' : ` Cases: ${falseReady.fixtureIds.join(', ')}.`}`,
    ...problems.map((problem) => `- Run: ${problem}`),
    ...evaluations.flatMap((evaluation) => evaluation.problems.map((problem) => `- ${evaluation.fixtureId}: ${problem}`)),
    'Snapshot results do not prove deferred workflow, clinical validity, payer authorization, payment or actual-agent quality.',
  ].join('\n');
  return { counts, falseReady, report };
}

/** Reuse the structural validation's full trust check without changing any frozen validator. */
export async function runAssessmentV2(
  batches: readonly unknown[] = V2_BATCHES,
  repoRoot = REPO_ROOT,
  fs: FileSystem = nodeFileSystem,
  assessor: typeof assessV2 = assessV2,
) {
  const trust = await runOraclesV2(batches, repoRoot, fs);
  const problems = [...trust.problems];
  const ids = [...new Set(batches.flatMap((batch) => {
    const parsed = FrozenBatchSchema.safeParse(batch);
    return parsed.success ? Object.keys(parsed.data.fixtures) : [];
  }))].sort();
  if (ids.length === 0) problems.push('no fixtures registered for assessment');
  const evaluations: V2Evaluation[] = [];
  for (const fixtureId of ids) {
    const evaluation: V2Evaluation = { fixtureId, expected: undefined, actual: undefined, problems: [] };
    evaluations.push(evaluation);
    if (problems.length > 0) {
      evaluation.problems.push('refused: registered suite trust check failed');
      continue;
    }
    try {
      const oracle = OracleV3.parse(scanJson(decodeUtf8(await fs.readFile(join(repoRoot, V2_SUITE_ROOT, 'oracles', `${fixtureId}.json`))) ?? '')?.value);
      evaluation.expected = oracle.expectation;
      const load = await loadFixture(join(repoRoot, V2_SUITE_ROOT), fixtureId, fs);
      if (load.outcome === 'refused') {
        evaluation.problems.push(...load.problems);
        continue;
      }
      if (load.outcome === 'rejected') {
        evaluation.actual = { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'rejected', rejection: load.rejection };
      } else {
        const fixture = load.fixture;
        const outcome = await assessor({
          caseBytes: fixture.caseBytes,
          documents: fixture.documents,
          policyPackBytes: await fs.readFile(join(repoRoot, fixture.policyInputPath)),
          assessmentDate: fixture.assessmentDate,
        });
        // Keep invalid or unfinished execution outside the measured outcomes.
        evaluation.actual = AssessmentOutcomeV3.parse(outcome);
        if (outcome.outcome === 'assessed') {
          const record: unknown = scanJson(decodeUtf8(fixture.caseBytes) ?? '')?.value;
          if (record === null || typeof record !== 'object' || !('caseId' in record) || !('revision' in record) || outcome.result.caseId !== record.caseId || outcome.result.caseRevision !== record.revision) {
            evaluation.problems.push('result names another case or revision');
          }
        }
      }
      evaluation.problems.push(...compareV2(evaluation.actual, oracle));
    } catch {
      evaluation.actual = undefined;
      evaluation.problems.push('refused: fixture read or assessment did not complete');
    }
  }
  const summary = reportV2(evaluations, problems);
  return {
    evaluations,
    problems,
    ...summary,
    exitCode: problems.length === 0 && summary.falseReady.complete && summary.counts.matched === ids.length ? 0 : 1,
  };
}
