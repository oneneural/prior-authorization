import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { CORE_BATCH } from '../frozen-v2.js';
import { auditFixtureFiles, checkBatch, checkUnion } from './batches.js';
import { V2_SUITE_ROOT } from './schemas.js';
import { addPinnedFixture, batchOf, digest, json, makeRepoCopy, removeTempDirs, standardDocuments, standardOracle, writeTree } from './test-support.js';

// Batch pins, union consistency, suite inventory and the per-fixture trust
// audit on temporary repository copies. Tampering changes one byte of a copy,
// never a frozen repository file. These tests use temporary arrays; the real
// registry is exercised through the command in command.test.ts.

afterAll(removeTempDirs);

/** Changes exactly one byte of a temporary copy. */
async function tamper(path: string) {
  const bytes = await readFile(path);
  const index = Math.floor(bytes.length / 2);
  bytes[index] = (bytes[index] ?? 0) ^ 0x01;
  await writeFile(path, bytes);
}

const fails = (problems: string[], fragment: string) => expect(problems.some((problem) => problem.includes(fragment)), `${fragment} in ${JSON.stringify(problems)}`).toBe(true);

async function twoBatchRepo() {
  const repo = await makeRepoCopy();
  const first = await addPinnedFixture(repo, { fixtureId: 'F01t', documents: standardDocuments() }, (sha) => standardOracle('F01t', sha));
  const second = await addPinnedFixture(repo, { fixtureId: 'F02t', documents: standardDocuments() }, (sha) => standardOracle('F02t', sha));
  return { repo, core: batchOf('policy-v2-core', { F01t: first }), extra: batchOf('policy-v2-extra', { F02t: second }), first, second };
}

describe('core-only and union loading', () => {
  it('verifies a temporary core-only array with zero fixtures', async () => {
    const repo = await makeRepoCopy();
    const core = batchOf(CORE_BATCH.batchId, {});
    expect((await checkBatch(core, repo)).problems).toEqual([]);
    const union = await checkUnion([core], repo);
    expect(union.problems).toEqual([]);
    expect(union.fixtures.size).toBe(0);
  });

  it('accepts two batches that share identical pack and input pins', async () => {
    const { repo, core, extra } = await twoBatchRepo();
    expect((await checkBatch(core, repo)).problems).toEqual([]);
    expect((await checkBatch(extra, repo)).problems).toEqual([]);
    const union = await checkUnion([core, extra], repo);
    expect(union.problems).toEqual([]);
    expect([...union.fixtures.keys()]).toEqual(['F01t', 'F02t']);
  });

  it('refuses duplicate identities and incompatible roots or versions', async () => {
    const { repo, core, extra, first } = await twoBatchRepo();
    fails((await checkUnion([core, { ...extra, batchId: core.batchId }], repo)).problems, 'batch ID policy-v2-core is registered twice');
    fails((await checkUnion([core, batchOf('policy-v2-again', { F01t: first })], repo)).problems, 'fixture F01t is pinned by batches policy-v2-core and policy-v2-again');
    fails((await checkUnion([core, batchOf('policy-v2-case', { F01T: first })], repo)).problems, 'differs from fixture F01t only by letter case');
    fails((await checkUnion([core, { ...extra, root: 'evals/suites/other' }], repo)).problems, 'registered batch 1 is malformed');
    fails((await checkUnion([core, { ...extra, formatVersions: { manifest: 'pa.fixture-manifest.v1', oracle: 'pa.oracle.v3' } }], repo)).problems, 'registered batch 1 is malformed');
    fails((await checkUnion([], repo)).problems, 'no batch is registered');
  });

  it('refuses conflicting pins across batches', async () => {
    const { repo, core, extra } = await twoBatchRepo();
    const other = digest('other bytes');
    fails((await checkUnion([core, { ...extra, policyPack: { ...CORE_BATCH.policyPack, sha256: other } }], repo)).problems, 'is pinned to conflicting hashes or pack IDs');
    fails((await checkUnion([core, { ...extra, policyPack: { ...CORE_BATCH.policyPack, sha256: other } }], repo)).problems, 'is pinned to two hashes');
    fails((await checkUnion([core, { ...extra, policyPack: { ...CORE_BATCH.policyPack, path: 'policy-packs/copy.json' } }], repo)).problems, 'is pinned at two paths');
    fails((await checkUnion([core, { ...extra, policyPack: { ...CORE_BATCH.policyPack, packId: 'lab-other' } }], repo)).problems, 'is pinned to conflicting hashes or pack IDs');
  });

  it('refuses malformed tables', async () => {
    const repo = await makeRepoCopy();
    const core = batchOf(CORE_BATCH.batchId, {});
    for (const broken of [
      { ...core, extra: true },
      { ...core, policyPack: { ...CORE_BATCH.policyPack, sha256: 'ABC' } },
      { ...core, fixtures: { F01t: { manifestSha256: digest('m') } } },
      { ...core, fixtures: { '../F01t': { manifestSha256: digest('m'), oracleSha256: digest('o') } } },
      { ...core, policyInputs: [...CORE_BATCH.policyInputs, ...CORE_BATCH.policyInputs] },
      { ...core, policyPack: { ...CORE_BATCH.policyPack, path: '../policy-packs/x.json' } },
      { ...core, policyInputs: [{ ...CORE_BATCH.policyInputs[0], path: 'policy-packs/lab-k0823-jd-20261018-v2.json' }] },
    ]) {
      fails((await checkBatch(broken, repo)).problems, 'malformed batch');
      fails((await checkUnion([broken], repo)).problems, 'registered batch 0 is malformed');
    }
  });
});

describe('suite inventory against the union', () => {
  it('refuses a fixture directory or oracle without a pin and a pin without either', async () => {
    const { repo, core, extra } = await twoBatchRepo();
    const problems = (await checkUnion([core], repo)).problems;
    fails(problems, 'fixtures/F02t: fixture directory without a pin');
    fails(problems, 'oracles/F02t.json: oracle without a pinned fixture');
    const ghost = batchOf('policy-v2-ghost', { F09t: { manifestSha256: digest('m'), oracleSha256: digest('o') } });
    const missing = (await checkUnion([core, extra, ghost], repo)).problems;
    fails(missing, 'fixture F09t: pin without a fixture directory');
    fails(missing, 'fixture F09t: pin without an oracle');
    fails((await checkBatch(ghost, repo)).problems, 'fixture F09t manifest');
  });

  it('reports a suite entry that is a file instead of a directory without throwing', async () => {
    for (const name of ['fixtures', 'oracles', 'policy-inputs']) {
      const repo = await makeRepoCopy();
      const suite = join(repo, V2_SUITE_ROOT);
      await rm(join(suite, name), { recursive: true, force: true });
      await writeTree(suite, { [name]: 'not a directory' });
      const inputs = name === 'policy-inputs' ? { policyInputs: [] } : {};
      const problems = (await checkUnion([batchOf(CORE_BATCH.batchId, {}, inputs)], repo)).problems;
      expect(problems).toEqual([`${V2_SUITE_ROOT}/${name}: not part of the suite layout`]);
    }
  });

  it('refuses an unpinned negative input and an entry outside the suite layout', async () => {
    const { repo, core, extra } = await twoBatchRepo();
    const suite = join(repo, V2_SUITE_ROOT);
    await writeTree(suite, { 'policy-inputs/unpinned.json': '{}', 'notes.txt': 'x' });
    const problems = (await checkUnion([core, extra], repo)).problems;
    fails(problems, 'policy-inputs/unpinned.json: negative policy input without a pin');
    fails(problems, `${V2_SUITE_ROOT}/notes.txt: not part of the suite layout`);
  });
});

describe('one-byte tampering fails its gate', () => {
  it('in the pack, the negative input, a manifest and an oracle (batch pins)', async () => {
    const cases: [string, string][] = [
      [CORE_BATCH.policyPack.path, 'policy pack policy-packs/lab-k0823-jd-20261018-v2.json: SHA-256 differs from its pin'],
      [CORE_BATCH.policyInputs[0].path, 'policy input evals/suites/policy-v2/policy-inputs/lab-k0823-jd-20261018-unreviewed.json: SHA-256 differs from its pin'],
      [`${V2_SUITE_ROOT}/fixtures/F01t/manifest.json`, 'fixture F01t manifest'],
      [`${V2_SUITE_ROOT}/oracles/F01t.json`, 'fixture F01t oracle'],
    ];
    for (const [path, fragment] of cases) {
      const { repo, core } = await twoBatchRepo();
      expect((await checkBatch(core, repo)).problems).toEqual([]);
      await tamper(join(repo, path));
      fails((await checkBatch(core, repo)).problems, fragment);
    }
  });

  it('in a source payload, a metadata sidecar and a template (fixture trust audit)', async () => {
    for (const path of ['documents/t-order.v2.json', 'documents/t-order.v2.meta.json', 'documents/t-x.template.json', 'case.json']) {
      const repo = await makeRepoCopy();
      await addPinnedFixture(repo, { fixtureId: 'F01t', documents: standardDocuments(), extraFiles: { 'documents/t-x.template.json': '{"text": "@@PAD@@"}' } }, (sha) => standardOracle('F01t', sha));
      expect(await auditFixtureFiles(repo, 'F01t')).toEqual([]);
      await tamper(join(repo, V2_SUITE_ROOT, 'fixtures', 'F01t', path));
      expect(await auditFixtureFiles(repo, 'F01t')).toEqual([`fixtures/F01t/${path}: SHA-256 differs from the manifest`]);
    }
  });

  it('refuses parsed packs whose ID differs from the pin', async () => {
    const repo = await makeRepoCopy();
    const pack = { ...CORE_BATCH.policyPack, packId: 'lab-renamed' };
    fails((await checkBatch(batchOf('policy-v2-core', {}, { policyPack: pack }), repo)).problems, 'packId differs from its pin');
    const input = { ...CORE_BATCH.policyInputs[0], packId: 'lab-renamed-input' };
    fails((await checkBatch(batchOf('policy-v2-core', {}, { policyInputs: [input] }), repo)).problems, 'packId differs from its pin');
  });

  it('accepts a trusted negative input that is not a valid pack, by its hash only', async () => {
    const repo = await makeRepoCopy();
    const path = `${V2_SUITE_ROOT}/policy-inputs/not-a-pack.json`;
    await writeTree(repo, { [path]: json({ schemaVersion: 'pa.policy-pack.v1' }) });
    const batch = batchOf('policy-v2-core', {}, { policyInputs: [...CORE_BATCH.policyInputs, { packId: 'lab-invalid-input', path, sha256: digest(json({ schemaVersion: 'pa.policy-pack.v1' })) }] });
    expect((await checkBatch(batch, repo)).problems).toEqual([]);
    expect((await checkUnion([batch], repo)).problems).toEqual([]);
  });
});

describe('fixture trust audit', () => {
  it('refuses unlisted, missing and non-regular files', async () => {
    const repo = await makeRepoCopy();
    await addPinnedFixture(repo, { fixtureId: 'F01t', documents: standardDocuments() }, (sha) => standardOracle('F01t', sha));
    const dir = join(repo, V2_SUITE_ROOT, 'fixtures', 'F01t');
    expect(await auditFixtureFiles(repo, 'F01t')).toEqual([]);

    await writeFile(join(dir, 'documents', 't-extra.v1.json'), '{}');
    expect(await auditFixtureFiles(repo, 'F01t')).toEqual(['fixtures/F01t/documents/t-extra.v1.json: not listed in the manifest']);
    await rm(join(dir, 'documents', 't-extra.v1.json'));

    await rm(join(dir, 'documents', 't-note.v1.json'));
    expect(await auditFixtureFiles(repo, 'F01t')).toEqual(['fixtures/F01t/documents/t-note.v1.json: listed in the manifest but missing']);
    await symlink('t-encounter.v1.json', join(dir, 'documents', 't-note.v1.json'));
    fails(await auditFixtureFiles(repo, 'F01t'), 'fixtures/F01t/documents/t-note.v1.json: not a regular file');
    await mkdir(join(dir, 'generated'));
    fails(await auditFixtureFiles(repo, 'F01t'), 'fixtures/F01t/generated: not a regular file');
  });
});
