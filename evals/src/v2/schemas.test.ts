import { describe, expect, it } from 'vitest';

import { CORE_BATCH } from '../frozen-v2.js';
import { FixtureManifestV2, FrozenBatchSchema, isReservedSlot, OracleV3 } from './schemas.js';
import { digest, fixtureFiles, standardDocuments, standardOracle } from './test-support.js';

// The strict structural formats: manifest v2, oracle v3 and FrozenBatch. Every
// object is strict, so an unknown key anywhere is refused.

const manifest = () => JSON.parse(fixtureFiles({ fixtureId: 'F01t', documents: standardDocuments() }).manifestText) as Record<string, unknown>;
const oracle = () => standardOracle('F01t', digest('manifest')) as unknown as Record<string, Record<string, unknown>>;

describe('fixture manifest v2', () => {
  it('accepts a generated manifest, with any assessmentDate string', () => {
    expect(FixtureManifestV2.safeParse(manifest()).success).toBe(true);
    expect(FixtureManifestV2.safeParse({ ...manifest(), assessmentDate: '' }).success).toBe(true);
    expect(FixtureManifestV2.safeParse({ ...manifest(), assessmentDate: 20261018 }).success).toBe(false);
  });

  it('refuses unknown keys, wrong versions and a missing case.json', () => {
    expect(FixtureManifestV2.safeParse({ ...manifest(), extra: 1 }).success).toBe(false);
    expect(FixtureManifestV2.safeParse({ ...manifest(), schemaVersion: 'pa.fixture-manifest.v1' }).success).toBe(false);
    const files = manifest().files as { path: string }[];
    expect(FixtureManifestV2.safeParse({ ...manifest(), files: files.filter((file) => file.path !== 'case.json') }).success).toBe(false);
    expect(FixtureManifestV2.safeParse({ ...manifest(), files: [...files, files[0]] }).success).toBe(false);
  });

  it('accepts only safe listed paths', () => {
    for (const path of ['../case.json', 'documents/../case.json', '/case.json', 'documents/a.txt', 'other/a.json', 'documents/sub/a.json', 'documents/.hidden.json']) {
      expect(FixtureManifestV2.safeParse({ ...manifest(), files: [...(manifest().files as unknown[]), { path, sha256: digest(path) }] }).success, path).toBe(false);
    }
  });

  it('refuses duplicate path-attempt slots and coverage entries', () => {
    const attempt = { slot: 'outside.v1', path: '../outside.json' };
    expect(FixtureManifestV2.safeParse({ ...manifest(), pathAttempts: [attempt] }).success).toBe(true);
    expect(FixtureManifestV2.safeParse({ ...manifest(), pathAttempts: [attempt, attempt] }).success).toBe(false);
    expect(FixtureManifestV2.safeParse({ ...manifest(), coverage: ['F01', 'F01'] }).success).toBe(false);
  });

  it('reserves slot names ending in .meta or .template (N3)', () => {
    expect(['a.meta', 'a.v1.template', 'x.meta'].every(isReservedSlot)).toBe(true);
    expect(['a.v1', 'a.metadata', 'meta.v1', 'a.templates'].some(isReservedSlot)).toBe(false);
  });
});

describe('oracle v3', () => {
  it('accepts the synthetic oracle and refuses unknown keys at every level', () => {
    expect(OracleV3.safeParse(oracle()).success).toBe(true);
    const base = oracle();
    expect(OracleV3.safeParse({ ...base, extra: 1 }).success).toBe(false);
    expect(OracleV3.safeParse({ ...base, specReferences: { ...base.specReferences, extra: 1 } }).success).toBe(false);
    expect(OracleV3.safeParse({ ...base, policyInput: { ...base.policyInput, path: 'x' } }).success).toBe(false);
    const findings = base.expectation?.findings as Record<string, unknown>[];
    expect(OracleV3.safeParse({ ...base, expectation: { ...base.expectation, findings: [{ ...findings[0], note: 'x' }, ...findings.slice(1)] } }).success).toBe(false);
  });

  it('checks reference vocabularies and requires rules and sections', () => {
    const base = oracle();
    for (const specReferences of [
      { ...base.specReferences, decisions: ['D7'] },
      { ...base.specReferences, conventions: ['C10'] },
      { ...base.specReferences, sources: ['S1'] },
      { ...base.specReferences, rules: [] },
      { ...base.specReferences, sections: [] },
      { ...base.specReferences, rules: ['R02', 'R02'] },
    ]) {
      expect(OracleV3.safeParse({ ...base, specReferences }).success, JSON.stringify(specReferences)).toBe(false);
    }
  });

  it('accepts rejected expectations only in the frozen envelope', () => {
    const rejected = (stage: string, reasons: unknown[]) => OracleV3.safeParse({ ...oracle(), expectation: { outcome: 'rejected', stage, reasons } }).success;
    expect(rejected('input_boundary', [{ code: 'path_outside_root', documentRef: null, path: null }])).toBe(true);
    expect(rejected('input_boundary', [{ code: 'path_outside_root', documentRef: null, path: '/documents' }])).toBe(false);
    expect(rejected('input_boundary', [{ code: 'case_invalid', documentRef: null, path: '/case' }])).toBe(false);
    expect(rejected('model', [{ code: 'case_invalid', documentRef: null, path: '/case' }])).toBe(false);
  });

  it('refuses duplicate quarantined or superseded references', () => {
    const base = oracle();
    const ref = { documentId: 't-note', version: 1 };
    expect(OracleV3.safeParse({ ...base, expectation: { ...base.expectation, quarantinedDocuments: [ref, ref] } }).success).toBe(false);
    expect(OracleV3.safeParse({ ...base, expectation: { ...base.expectation, supersededDocuments: [ref, ref] } }).success).toBe(false);
  });
});

describe('FrozenBatch', () => {
  it('accepts the frozen core batch', () => {
    expect(FrozenBatchSchema.safeParse(CORE_BATCH).success).toBe(true);
  });

  it('refuses another root, format version, pin location or a duplicate input', () => {
    for (const batch of [
      { ...CORE_BATCH, root: 'evals/suites/other-suite' },
      { ...CORE_BATCH, formatVersions: { manifest: 'pa.fixture-manifest.v2', oracle: 'pa.oracle.v2' } },
      { ...CORE_BATCH, policyPack: { ...CORE_BATCH.policyPack, path: 'evals/pack.json' } },
      { ...CORE_BATCH, policyInputs: [{ ...CORE_BATCH.policyInputs[0], path: 'policy-packs/input.json' }] },
      { ...CORE_BATCH, policyInputs: [CORE_BATCH.policyInputs[0], { ...CORE_BATCH.policyInputs[0], path: `${CORE_BATCH.root}/policy-inputs/copy.json` }] },
      { ...CORE_BATCH, fixtures: { 'F01/x': { manifestSha256: digest('m'), oracleSha256: digest('o') } } },
      { ...CORE_BATCH, extra: true },
    ]) {
      expect(FrozenBatchSchema.safeParse(batch).success, JSON.stringify(batch).slice(0, 120)).toBe(false);
    }
  });
});
