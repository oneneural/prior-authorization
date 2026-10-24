import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type AssessmentResult, PolicyPack } from '@pa/contracts';
import { describe, expect, it, vi } from 'vitest';

import * as fixtureFiles from './fixture.js';
import { checkFixture, FIXTURES_DIR, type LoadedFixture, ORACLES_DIR, POLICY_PACK_PATH } from './fixture.js';
import { FROZEN_ORACLES } from './frozen.js';
import { checkFrozen, compareWithOracle, evaluateFixture, type FixtureEvaluation, falseReady, falseReadyLine, loadFixtureInputs, validateResult } from './harness.js';
import { Oracle } from './schemas.js';

// The harness must reject results and inputs that would let a wrong assessment
// pass. Every tamper here is applied to an in-memory copy; the frozen oracle,
// fixture, manifest and pack bytes on disk never change.

async function assessed(fixtureId: string): Promise<{ result: AssessmentResult; fixture: LoadedFixture; oracle: Oracle }> {
  const inputs = await loadFixtureInputs(fixtureId);
  const evaluation = await evaluateFixture(inputs);
  expect(evaluation.problems).toEqual([]);
  const { fixture } = await checkFixture(join(FIXTURES_DIR, fixtureId));
  if (evaluation.result === undefined || fixture === undefined) {
    throw new Error(`${fixtureId} did not assess`);
  }
  return { result: evaluation.result, fixture, oracle: Oracle.parse(JSON.parse(Buffer.from(inputs.oracleBytes).toString('utf8'))) };
}

const copy = (result: AssessmentResult): AssessmentResult => structuredClone(result);
const pack = PolicyPack.parse(JSON.parse(await readFile(POLICY_PACK_PATH, 'utf8')));

describe('frozen inputs', () => {
  it('pins every slice oracle and the pack', async () => {
    for (const fixtureId of Object.keys(FROZEN_ORACLES)) {
      const inputs = await loadFixtureInputs(fixtureId);
      expect(checkFrozen(fixtureId, inputs.oracleBytes, inputs.packBytes)).toEqual([]);
    }
  });

  it('rejects a one-byte oracle change before comparing', async () => {
    const inputs = await loadFixtureInputs('F01');
    const tampered = new Uint8Array(inputs.oracleBytes);
    const index = Buffer.from(tampered).indexOf('ready_for_review');
    expect(index).toBeGreaterThan(0);
    tampered[index] = 'R'.charCodeAt(0);
    const evaluation = await evaluateFixture({ ...inputs, oracleBytes: tampered });
    expect(evaluation.actualState).toBeUndefined();
    expect(evaluation.problems).toEqual([expect.stringMatching(/^oracle F01 bytes .* differ from the frozen SHA-256/)]);
  });

  it('rejects a one-byte policy pack change', async () => {
    const inputs = await loadFixtureInputs('F01');
    const tampered = new Uint8Array(inputs.packBytes);
    const index = tampered.lastIndexOf('}'.charCodeAt(0)) - 2;
    tampered[index] = (tampered[index] ?? 0) ^ 0x20;
    const evaluation = await evaluateFixture({ ...inputs, packBytes: tampered });
    expect(evaluation.problems).toEqual([expect.stringMatching(/^policy pack bytes .* differ from the frozen SHA-256/)]);
  });

  it('freezes exactly the oracle files on disk, so none is silently skipped', async () => {
    const files = (await readdir(ORACLES_DIR)).filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -'.json'.length));
    expect(files.sort()).toEqual(Object.keys(FROZEN_ORACLES).sort());
  });

  it('rejects a fixture without a frozen oracle', async () => {
    const inputs = await loadFixtureInputs('F01');
    expect(checkFrozen('F99', inputs.oracleBytes, inputs.packBytes)).toEqual(['F99 has no frozen oracle hash']);
  });

  it.each(['fixtureId', 'policyPackSha256'] as const)('excludes a pinned oracle with the wrong %s from false-ready', async (field) => {
    const inputs = await loadFixtureInputs('F01');
    const oracle = Oracle.parse(JSON.parse(Buffer.from(inputs.oracleBytes).toString('utf8')));
    oracle[field] = field === 'fixtureId' ? 'F02' : '0'.repeat(64);
    const oracleBytes = Buffer.from(JSON.stringify(oracle));
    const hash = fixtureFiles.sha256;
    // Simulate a matching pin in memory to reach the independent identity gate.
    const pin = vi.spyOn(fixtureFiles, 'sha256').mockImplementation((bytes) => bytes === oracleBytes ? FROZEN_ORACLES.F01! : hash(bytes));
    try {
      const evaluation = await evaluateFixture({ ...inputs, oracleBytes });
      expect(evaluation.problems).toEqual(['the oracle names another fixture or policy pack']);
      expect(evaluation.expectedState).toBeUndefined();
      expect(evaluation.actualState).toBeUndefined();
      expect(falseReady([evaluation])).toMatchObject({ denominator: 0, refused: ['F01'], notRun: [], complete: false });
    } finally {
      pin.mockRestore();
    }
  });
});

describe('result validation', () => {
  it('accepts the unmodified results', async () => {
    for (const fixtureId of ['F01', 'F08a', 'F08b', 'F25']) {
      const { result, fixture, oracle } = await assessed(fixtureId);
      expect(validateResult(result, fixture, oracle, pack)).toEqual([]);
    }
  });

  it('rejects a dangling evidenceFactIds reference', async () => {
    const { result, fixture, oracle } = await assessed('F01');
    const tampered = copy(result);
    tampered.findings[2]?.evidenceFactIds.push('fact-9999');
    expect(validateResult(tampered, fixture, oracle, pack)).toEqual(
      expect.arrayContaining(['R03 cites unknown fact fact-9999', expect.stringMatching(/^contract: .*unknown fact fact-9999/)]),
    );
  });

  it('rejects an appended fact from the quarantined document', async () => {
    const { result, fixture, oracle } = await assessed('F08a');
    const tampered = copy(result);
    tampered.evidenceFacts.push({
      ...(tampered.evidenceFacts[0] as AssessmentResult['evidenceFacts'][number]),
      factId: 'fact-9999',
      field: 'encounter.beneficiary_name',
      documentId: 'f08a-attachment',
      documentVersion: 1,
      locator: '/beneficiary/name',
      value: 'Morgan Othercase',
      originalText: 'Morgan Othercase',
    });
    expect(validateResult(tampered, fixture, oracle, pack)).toEqual(
      expect.arrayContaining([
        'fact fact-9999 comes from quarantined document f08a-attachment',
        'fact fact-9999 contains text from a quarantined document',
        expect.stringMatching(/^contract: evidenceFacts\.\d+\.documentId: a quarantined document contributes no facts/),
      ]),
    );
  });

  it('rejects quarantined content or references outside R02', async () => {
    const { result, fixture, oracle } = await assessed('F08b');
    const tampered = copy(result);
    const r03 = tampered.findings.find((finding) => finding.ruleId === 'R03');
    if (r03 === undefined) {
      throw new Error('no R03 finding');
    }
    r03.explanation = 'The quarantined order f08b-order names SYN-BEN-X802.';
    r03.documentRefs.push({ documentId: 'f08b-order', version: 1 });
    expect(validateResult(tampered, fixture, oracle, pack)).toEqual(
      expect.arrayContaining([
        'R03 names quarantined document f08b-order; only R02 may (C07)',
        'R03 explanation contains text from a quarantined document',
        'R03 explanation names quarantined document f08b-order; only R02 may (C07)',
      ]),
    );
  });

  it('rejects a fact whose value, text or locator no longer matches its source', async () => {
    const { result, fixture, oracle } = await assessed('F01');
    const tampered = copy(result);
    const [first, second, third] = tampered.evidenceFacts;
    if (first === undefined || second === undefined || third === undefined) {
      throw new Error('too few facts');
    }
    first.value = 'Someone Else';
    second.originalText = 'not the source text';
    third.documentVersion = 2;
    const problems = validateResult(tampered, fixture, oracle, pack);
    expect(problems).toEqual(
      expect.arrayContaining([
        `fact ${first.factId}: ${first.locator} in ${first.documentId} v1 does not hold the fact's value`,
        `fact ${second.factId}: originalText does not state the fact's value`,
        `fact ${third.factId} cites ${third.documentId} v2, which is not in the fixture`,
      ]),
    );
  });
});

describe('facts come only from usable documents', () => {
  it.each<[string, (meta: LoadedFixture['documents'][number]['meta']) => LoadedFixture['documents'][number]['meta'], RegExp]>([
    ['an unreadable access status', (meta) => ({ ...meta, accessStatus: 'unreadable' }), /whose access status is unreadable$/],
    ['an unsupported MIME type', (meta) => ({ ...meta, mimeType: 'text/plain' }), /whose MIME type text\/plain the pack does not support$/],
    ['a body kind that differs from its metadata', (meta) => ({ ...meta, kind: 'supporting_note' }), /whose body kind order differs from its metadata kind supporting_note$/],
  ])('rejects a fact from a document with %s', async (_, tamper, problem) => {
    const { result, fixture, oracle } = await assessed('F01');
    const fact = result.evidenceFacts.find((candidate) => candidate.field.startsWith('order.'));
    if (fact === undefined) {
      throw new Error('no order fact');
    }
    const documents = fixture.documents.map((document) => (document.meta.documentId === fact.documentId ? { ...document, meta: tamper(document.meta) } : document));
    expect(validateResult(result, { ...fixture, documents }, oracle, pack)).toEqual(expect.arrayContaining([expect.stringMatching(problem)]));
  });
});

describe('complete-set comparison', () => {
  it('fails on a changed status, a missing citation, an extra affected document and a missing finding', async () => {
    const { result, oracle } = await assessed('F08a');
    const tampered = copy(result);
    const [r01, r02, r03] = tampered.findings;
    if (r01 === undefined || r02 === undefined || r03 === undefined) {
      throw new Error('too few findings');
    }
    r01.status = 'missing';
    r03.evidenceFactIds.pop();
    r02.documentRefs.push({ documentId: 'f08a-order', version: 1 });
    tampered.findings = tampered.findings.filter((finding) => finding.ruleId !== 'R10');
    expect(compareWithOracle(tampered, oracle)).toEqual(
      expect.arrayContaining([
        'R01: status missing, expected pass',
        expect.stringMatching(/^R03 citations: missing \[f08a-order@v1\/signature\/signedDate\], unexpected \[\]/),
        'R02 affected documents: missing [], unexpected [f08a-order@v1]',
        'findings by rule: missing [R10], unexpected []',
      ]),
    );
  });

  it('fails on a different state and quarantine list', async () => {
    const { result, oracle } = await assessed('F08a');
    const tampered = { ...copy(result), state: 'ready_for_review' as const, quarantinedDocumentIds: [] };
    expect(compareWithOracle(tampered, oracle)).toEqual([
      'state ready_for_review, expected needs_human_review',
      'quarantined documents: missing [f08a-attachment], unexpected []',
    ]);
  });
});

describe('false-ready count', () => {
  const evaluation = (fixtureId: string, expectedState: FixtureEvaluation['expectedState'], actualState: FixtureEvaluation['actualState']): FixtureEvaluation => ({
    fixtureId,
    expectedState,
    actualState,
    problems: [],
    result: undefined,
  });

  it('counts a ready result for a blocked case over every blocked case', () => {
    const evaluations = [
      evaluation('A', 'ready_for_review', 'ready_for_review'),
      evaluation('B', 'needs_information', 'ready_for_review'),
      evaluation('C', 'needs_human_review', 'needs_human_review'),
      evaluation('D', 'scope_hold', 'rejected'),
    ];
    expect(falseReady(evaluations)).toEqual({ numerator: 1, denominator: 3, fixtureIds: ['B'], refused: [], notRun: [], complete: true });
    expect(falseReadyLine(evaluations)).toBe('False-ready: 1 of 3 fixtures whose oracle expects a state other than ready_for_review (4 fixtures assessed): B.');
  });

  it('excludes a refused oracle from both counts and says the count was not computed', () => {
    const evaluations = [
      evaluation('A', 'needs_information', 'needs_information'),
      evaluation('B', undefined, undefined),
      evaluation('C', 'scope_hold', undefined),
    ];
    expect(falseReady(evaluations)).toEqual({ numerator: 0, denominator: 2, fixtureIds: [], refused: ['B'], notRun: ['C'], complete: false });
    expect(falseReadyLine(evaluations)).toBe(
      'False-ready: not computed, 1 oracle refused (B), 1 fixture not run (C); of the rest, 0 of 2 assessed ready_for_review against a blocked oracle.',
    );
  });

  it('reports a refused oracle on the summary line of a real run', async () => {
    const inputs = await loadFixtureInputs('F02');
    const tampered = new Uint8Array(inputs.oracleBytes);
    tampered[tampered.length - 2] = (tampered[tampered.length - 2] ?? 0) ^ 0x01;
    const evaluations = [await evaluateFixture(await loadFixtureInputs('F01')), await evaluateFixture({ ...inputs, oracleBytes: tampered })];
    expect(falseReadyLine(evaluations)).toMatch(/^False-ready: not computed, 1 oracle refused \(F02\);/);
  });
});
