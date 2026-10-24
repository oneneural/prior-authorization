import { cp, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { checkFixture, checkOracle, FIXTURES_DIR, loadOracle, loadPolicyPack, ORACLES_DIR, type LoadedFixture } from './fixture.js';

const SLICE = ['F01', 'F02', 'F06', 'F08a', 'F08b', 'F22', 'F23', 'F25'];
const { pack, sha256: packSha256 } = await loadPolicyPack();

async function loadValid(dir: string): Promise<LoadedFixture> {
  const check = await checkFixture(dir);
  expect(check.problems).toEqual([]);
  if (check.fixture === undefined) {
    throw new Error(`fixture ${dir} did not load`);
  }
  return check.fixture;
}

describe('first-slice fixture set', () => {
  it('holds exactly the slice fixtures, each with one oracle', async () => {
    const fixtures = (await readdir(FIXTURES_DIR, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    expect(fixtures.sort()).toEqual([...SLICE].sort());
    expect((await readdir(ORACLES_DIR)).sort()).toEqual(SLICE.map((id) => `${id}.json`).sort());
  });
});

describe.each(SLICE)('fixture %s', (fixtureId) => {
  it('matches its manifest byte for byte and parses with the contracts', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, fixtureId));
    expect(fixture.manifest.fixtureId).toBe(fixtureId);
    expect(fixture.caseRecord.state).toBe('intake');
    expect(fixture.caseRecord.synthetic).toBe(true);
    expect(fixture.documents.every((document) => document.meta.syntheticProvenance.origin === 'authored_synthetic')).toBe(true);
  });

  it('has an oracle that agrees with the fixture and the policy pack', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, fixtureId));
    const oracle = await loadOracle(fixtureId);
    expect(checkOracle(oracle, fixture, pack, packSha256)).toEqual([]);
  });
});

describe('tamper detection', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'pa-fixture-'));
    await cp(join(FIXTURES_DIR, 'F01'), dir, { recursive: true });
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function flipOneByte(path: string, marker: string) {
    const bytes = await readFile(path);
    const index = bytes.indexOf(marker);
    expect(index).toBeGreaterThanOrEqual(0);
    bytes[index] = (bytes[index] ?? 0) ^ 0x01;
    await writeFile(path, bytes);
  }

  it('starts from a valid copy', async () => {
    const fixture = await loadValid(dir);
    expect(checkOracle(await loadOracle('F01'), fixture, pack, packSha256)).toEqual([]);
  });

  it('detects a one-byte change to a source document', async () => {
    await flipOneByte(join(dir, 'documents', 'f01-order.v1.json'), 'Power wheelchair');
    const { problems } = await checkFixture(dir);
    expect(problems).toEqual([
      'documents/f01-order.v1.json: SHA-256 differs from the manifest',
      'documents/f01-order.v1.json: SHA-256 differs from contentHash in documents/f01-order.v1.meta.json',
    ]);
  });

  it('detects a one-byte change to the manifest', async () => {
    await flipOneByte(join(dir, 'manifest.json'), 'Supported K0823');
    const fixture = await loadValid(dir);
    expect(checkOracle(await loadOracle('F01'), fixture, pack, packSha256)).toEqual([
      expect.stringMatching(/^fixtureManifestSha256 [0-9a-f]{64} differs from manifest\.json/),
    ]);
  });

  it('detects an unlisted file', async () => {
    await writeFile(join(dir, 'documents', 'extra.v1.json'), '{}\n');
    const { problems } = await checkFixture(dir);
    expect(problems).toContain('documents/extra.v1.json: source bytes without metadata');
    expect(problems.some((problem) => problem.startsWith('manifest lists'))).toBe(true);
  });
});

describe('oracle checks', () => {
  it('reject an oracle that misses a rule, cites a quarantined document or omits a citation', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, 'F08a'));
    const oracle = await loadOracle('F08a');
    const [first, ...rest] = oracle.expectedFindings;
    expect(checkOracle({ ...oracle, expectedFindings: rest }, fixture, pack, packSha256)).toEqual([expect.stringMatching(/^expected findings cover/)]);

    const leaking = oracle.expectedFindings.map((finding) =>
      finding.ruleId === 'R06'
        ? { ...finding, citations: [...finding.citations, { documentId: 'f08a-attachment', documentVersion: 1, locator: '/clinical/mobilityLimitation' }] }
        : finding,
    );
    expect(checkOracle({ ...oracle, expectedFindings: leaking }, fixture, pack, packSha256)).toEqual(['R06: cites quarantined document f08a-attachment']);

    const trimmed = first === undefined ? [] : [{ ...first, citations: first.citations.slice(1) }, ...rest];
    expect(checkOracle({ ...oracle, expectedFindings: trimmed }, fixture, pack, packSha256)).toEqual([
      'R01: omits f08a-supplier-status@v1/supplierId (supplier.id) required by convention C05',
    ]);
  });

  it('reject an expected state that is not the highest state effect of the expected statuses', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, 'F06'));
    const oracle = await loadOracle('F06');
    expect(checkOracle({ ...oracle, expectedState: 'ready_for_review' }, fixture, pack, packSha256)).toEqual([
      'expectedState ready_for_review, but the highest pack state effect of the expected statuses selects needs_human_review',
    ]);
  });

  it('reject a different policy pack byte sequence', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, 'F01'));
    expect(checkOracle(await loadOracle('F01'), fixture, pack, '0'.repeat(64))).toEqual([
      expect.stringMatching(/^policyPackSha256 [0-9a-f]{64} differs from the policy pack file/),
    ]);
  });

  it('reject affected documents outside convention C07', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, 'F08a'));
    const oracle = await loadOracle('F08a');
    const unnamed = oracle.expectedFindings.map((finding) => (finding.ruleId === 'R02' ? { ...finding, affectedDocuments: [] } : finding));
    expect(checkOracle({ ...oracle, expectedFindings: unnamed }, fixture, pack, packSha256)).toEqual([
      'R02: affected documents [] differ from quarantinedDocumentIds [f08a-attachment] (C07)',
    ]);
    const spread = oracle.expectedFindings.map((finding) =>
      finding.ruleId === 'R03' ? { ...finding, affectedDocuments: [{ documentId: 'f08a-attachment', version: 1 }] } : finding,
    );
    expect(checkOracle({ ...oracle, expectedFindings: spread }, fixture, pack, packSha256)).toEqual([
      'R03: names quarantined document f08a-attachment; only R02 does (C07)',
      'R03: a pass finding names no documents (C07)',
    ]);
  });

  it('reject a status or role the rule does not declare', async () => {
    const fixture = await loadValid(join(FIXTURES_DIR, 'F01'));
    const oracle = await loadOracle('F01');
    const changed = oracle.expectedFindings.map((finding) =>
      finding.ruleId === 'R06' ? { ...finding, status: 'pass' as const } : finding.ruleId === 'R03' ? { ...finding, responsibleRole: 'authorization_coordinator' as const } : finding,
    );
    expect(checkOracle({ ...oracle, expectedFindings: changed }, fixture, pack, packSha256)).toEqual([
      'R03: role authorization_coordinator, the pack assigns administrative_reviewer to pass',
      'R06: status pass is not an outcome of the rule',
    ]);
  });
});
