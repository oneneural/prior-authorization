import { createHash } from 'node:crypto';

import { afterAll, describe, expect, it } from 'vitest';

import { CORE_BATCH } from '../frozen-v2.js';
import { V2_BATCHES } from '../v2-batches.js';
import { runOraclesV2 } from './command.js';
import { addPinnedFixture, batchOf, copyRealSuite, json, makeRepoCopy, metadata, noteBody, removeTempDirs, standardDocuments, standardOracle } from './test-support.js';

// `pnpm test:oracles:v2` through its command function. The real registry is
// used on a disposable copy of the real suite, with one appended synthetic
// batch, so these tests stay valid as later tasks register more batches. They
// never assert how many batches or fixtures the real registry holds.

afterAll(removeTempDirs);

const audit = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const EXTRA_ID = 'F01t014';
const realFixtureIds = V2_BATCHES.flatMap((batch) => Object.keys(batch.fixtures));
const realCount = realFixtureIds.length;

const countRejection = { outcome: 'rejected', stage: 'input_boundary', reasons: [{ code: 'document_count_exceeded', documentRef: null, path: '/documents' }] };
const withExpectation = (fixtureId: string, expectation: unknown) => (sha: string) => {
  const oracle = standardOracle(fixtureId, sha);
  return { ...oracle, specReferences: { ...oracle.specReferences, fixtureRow: 'F26' }, expectation };
};

/** 51 replicated copies of one supporting note: a count rejection whose recipe pins the audit still verifies. */
function replicatedFixture(wrongPinAt?: number) {
  const payload = json(noteBody('Replicated payload.'));
  const template = json(metadata('t-copy-@@N@@', 1, 'supporting_note', payload));
  const outputs = Array.from({ length: 51 }, (_, index) => {
    const text = template.replaceAll('@@N@@', String(index + 1).padStart(2, '0'));
    return { slot: `t-copy-${String(index + 1).padStart(2, '0')}.v1`, metadataSha256: audit(index === wrongPinAt ? 'wrong' : text) };
  });
  return {
    fixtureId: EXTRA_ID,
    specFixtureRow: 'F26',
    extraFiles: { 'documents/t-copy.payload.template.json': payload, 'documents/t-copy.meta.template.json': template },
    manifest: { recipes: [{ recipe: 'replicate', payload: 'documents/t-copy.payload.template.json', metadataTemplate: 'documents/t-copy.meta.template.json', placeholder: '@@N@@', count: 51, width: 2, outputs }] },
  };
}

describe('pnpm test:oracles:v2 command', () => {
  it('reports zero authored fixtures honestly for a temporary core-only array', async () => {
    const repo = await makeRepoCopy();
    const result = await runOraclesV2([batchOf(CORE_BATCH.batchId, {})], repo);
    expect(result.problems).toEqual([]);
    expect(result.exitCode).toBe(0);
    expect(result.report).toContain('Union: 1 batch(es), 0 authored fixture(s); consistent and the suite inventory matches');
    expect(result.report).toContain('Loader: 0 fixture(s): 0 loaded, 0 rejected at input_boundary, 0 refused');
    expect(result.report).toContain('no assessment, no false-ready measurement and no policy outcome is computed');
  });

  // This case copies and validates the whole registered suite, so its time grows with each batch.
  it('passes the real registry on a disposable copy of the real suite and an appended batch', async () => {
    expect(realFixtureIds).not.toContain(EXTRA_ID);
    const repo = await copyRealSuite(V2_BATCHES);
    const real = await runOraclesV2(V2_BATCHES, repo);
    expect(real.problems).toEqual([]);
    expect(real.report).toContain(`Union: ${V2_BATCHES.length} batch(es), ${realCount} authored fixture(s)`);

    const pin = await addPinnedFixture(repo, { fixtureId: EXTRA_ID, documents: standardDocuments() }, (sha) => standardOracle(EXTRA_ID, sha));
    const union = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: pin })], repo);
    expect(union.problems).toEqual([]);
    expect(union.exitCode).toBe(0);
    expect(union.report).toContain(`Union: ${V2_BATCHES.length + 1} batch(es), ${realCount + 1} authored fixture(s)`);
    expect(union.report).toContain(`${EXTRA_ID} (policy-v2-test-extra): loader loaded 6 document(s); oracle structurally consistent`);

    // The appended fixture's directory without its registration is an inventory gap.
    const unregistered = await runOraclesV2(V2_BATCHES, repo);
    expect(unregistered.exitCode).toBe(1);
    expect(unregistered.report).toContain(`fixtures/${EXTRA_ID}: fixture directory without a pin`);
  }, 60_000);

  // This case copies and validates the whole registered suite, so its time grows with each batch.
  it('fails on a changed oracle byte', async () => {
    const repo = await copyRealSuite(V2_BATCHES);
    const pin = await addPinnedFixture(repo, { fixtureId: EXTRA_ID, documents: standardDocuments() }, (sha) => standardOracle(EXTRA_ID, sha));
    const result = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: { ...pin, oracleSha256: audit('other') } })], repo);
    expect(result.exitCode).toBe(1);
    expect(result.report).toContain('FAILED');
    expect(result.problems.some((problem) => problem.includes(`fixture ${EXTRA_ID} oracle`))).toBe(true);
  }, 60_000);

  // This case copies and validates the whole registered suite, so its time grows with each batch.
  it('compares the loader outcome with the expected input-boundary rejection', async () => {
    const restricted = Object.fromEntries(Array.from({ length: 51 }, (_, index) => [`t-r${index + 1}.v1`, { meta: metadata(`t-r${index + 1}`, 1, 'order', null) }]));
    const spec = { fixtureId: EXTRA_ID, specFixtureRow: 'F26', documents: restricted };

    const matching = await copyRealSuite(V2_BATCHES);
    const pin = await addPinnedFixture(matching, spec, withExpectation(EXTRA_ID, countRejection));
    const passed = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: pin })], matching);
    expect(passed.problems).toEqual([]);
    expect(passed.report).toContain(`${EXTRA_ID} (policy-v2-test-extra): loader rejected at input_boundary (document_count_exceeded); oracle structurally consistent`);

    const mismatched = await copyRealSuite(V2_BATCHES);
    const wrong = await addPinnedFixture(mismatched, spec, (sha) => ({ ...withExpectation(EXTRA_ID, undefined)(sha), expectation: standardOracle(EXTRA_ID, sha).expectation }));
    const failed = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: wrong })], mismatched);
    expect(failed.exitCode).toBe(1);
    expect(failed.problems).toContain(`fixture ${EXTRA_ID} oracle: the loader rejects the fixture at input_boundary, but the oracle expects an assessed result`);
  }, 60_000);

  // This case copies and validates the whole registered suite, so its time grows with each batch.
  it('runs the recipe pin audit separately, also for a count-rejected fixture', async () => {
    const good = await copyRealSuite(V2_BATCHES);
    const pin = await addPinnedFixture(good, replicatedFixture(), withExpectation(EXTRA_ID, countRejection));
    const passed = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: pin })], good);
    expect(passed.problems).toEqual([]);
    expect(passed.report).toContain('loader rejected at input_boundary (document_count_exceeded)');
    expect(passed.report).toMatch(/Recipe pin audit \(separate from loader results\): [1-9][0-9]* recipe\(s\) in [1-9][0-9]* fixture\(s\), [0-9]+ pinned output\(s\) verified/);

    const bad = await copyRealSuite(V2_BATCHES);
    const badPin = await addPinnedFixture(bad, replicatedFixture(50), withExpectation(EXTRA_ID, countRejection));
    const failed = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: badPin })], bad);
    expect(failed.exitCode).toBe(1);
    expect(failed.report).toContain('loader rejected at input_boundary (document_count_exceeded)');
    expect(failed.problems).toContain(`fixture ${EXTRA_ID} recipe pin audit: recipe 0 (replicate): copy 51 metadata SHA-256 differs from its pin`);
  }, 60_000);

  // This case copies and validates the whole registered suite, so its time grows with each batch.
  it('fails a generated-output pin when a re-listed template changes by one byte', async () => {
    // The manifest lists the changed template with its new hash, so only the recipe output pin is stale.
    const original = replicatedFixture();
    const changedMeta = original.extraFiles['documents/t-copy.meta.template.json'].replace('Original synthetic', 'Original Synthetic');
    expect(changedMeta).not.toBe(original.extraFiles['documents/t-copy.meta.template.json']);
    const repo = await copyRealSuite(V2_BATCHES);
    const pin = await addPinnedFixture(repo, { ...original, extraFiles: { ...original.extraFiles, 'documents/t-copy.meta.template.json': changedMeta } }, withExpectation(EXTRA_ID, countRejection));
    const failed = await runOraclesV2([...V2_BATCHES, batchOf('policy-v2-test-extra', { [EXTRA_ID]: pin })], repo);
    expect(failed.exitCode).toBe(1);
    expect(failed.problems).toContain(`fixture ${EXTRA_ID} recipe pin audit: recipe 0 (replicate): copy 1 metadata SHA-256 differs from its pin`);
  }, 60_000);
});
