import { join } from 'node:path';

import { PolicyPackV2 } from '@pa/contracts';

import { contentFree, decodeUtf8, describeIssues, type FileSystem, lstatOrNull, nodeFileSystem, sha256 } from './files.js';
import { scanJson } from './json-scan.js';
import { readManifest } from './loader.js';
import { type FrozenBatch, FrozenBatchSchema, type PolicyPin, V2_SUITE_ROOT } from './schemas.js';

// Trust and inventory for the registered v2 batches (docs/policy-slice.md
// "Batch extension interface"). A batch is hash data only. Each selected batch's
// own pins are verified first; then the whole registered union is checked for
// consistency and against the one shared suite root, since every batch shares
// it. Any difference is a refusal: bytes and pins are never repaired.

const SUITE_ENTRIES = new Set(['fixtures', 'oracles', 'policy-inputs']);

export interface PinnedFixture {
  batchId: string;
  fixtureId: string;
  manifestSha256: string;
  oracleSha256: string;
}

/** Reads a pinned regular file, refusing a link, a missing file or other bytes. */
async function readPinned(fs: FileSystem, repoRoot: string, path: string, pinned: string, what: string): Promise<{ bytes: Uint8Array | null; problems: string[] }> {
  const info = await lstatOrNull(fs, join(repoRoot, path));
  if (info === null || !info.isFile()) {
    return { bytes: null, problems: [`${what} ${path}: missing or not a regular file`] };
  }
  const bytes = await fs.readFile(join(repoRoot, path));
  return { bytes, problems: sha256(bytes) === pinned ? [] : [`${what} ${path}: SHA-256 differs from its pin`] };
}

const parsePack = (bytes: Uint8Array) => {
  const text = decodeUtf8(bytes);
  const scan = text === null ? null : scanJson(text);
  return scan === null ? null : PolicyPackV2.safeParse(scan.value);
};

/** One batch's own pins: the reviewed pack, every negative policy input and every fixture's manifest and oracle bytes. */
export async function checkBatch(candidate: unknown, repoRoot: string, fs: FileSystem = nodeFileSystem): Promise<{ batch: FrozenBatch | null; problems: string[] }> {
  const parsed = FrozenBatchSchema.safeParse(candidate);
  if (!parsed.success) {
    return { batch: null, problems: [`malformed batch: ${describeIssues(parsed.error)}`] };
  }
  const batch = parsed.data;
  return contentFree(`batch ${batch.batchId}`, () => checkPins(batch, repoRoot, fs), (problem) => ({ batch, problems: [problem] }));
}

async function checkPins(batch: FrozenBatch, repoRoot: string, fs: FileSystem): Promise<{ batch: FrozenBatch; problems: string[] }> {
  const label = `batch ${batch.batchId}:`;
  const problems: string[] = [];

  const pack = await readPinned(fs, repoRoot, batch.policyPack.path, batch.policyPack.sha256, `${label} policy pack`);
  problems.push(...pack.problems);
  if (pack.bytes !== null && pack.problems.length === 0) {
    const parsedPack = parsePack(pack.bytes);
    if (parsedPack === null || !parsedPack.success) {
      problems.push(`${label} policy pack ${batch.policyPack.path}: not a valid pa.policy-pack.v2`);
    } else if (parsedPack.data.packId !== batch.policyPack.packId) {
      problems.push(`${label} policy pack ${batch.policyPack.path}: packId differs from its pin`);
    }
  }
  // A negative input is trusted by its hash. One that parses must carry its pinned ID; one that does
  // not parse is a trusted invalid-pack input. Neither marks a policy reviewed.
  for (const input of batch.policyInputs) {
    const read = await readPinned(fs, repoRoot, input.path, input.sha256, `${label} policy input`);
    problems.push(...read.problems);
    const parsedInput = read.bytes === null || read.problems.length > 0 ? null : parsePack(read.bytes);
    if (parsedInput?.success === true && parsedInput.data.packId !== input.packId) {
      problems.push(`${label} policy input ${input.path}: packId differs from its pin`);
    }
  }
  for (const [fixtureId, pin] of Object.entries(batch.fixtures)) {
    const manifest = await readPinned(fs, repoRoot, `${batch.root}/fixtures/${fixtureId}/manifest.json`, pin.manifestSha256, `${label} fixture ${fixtureId} manifest`);
    const oracle = await readPinned(fs, repoRoot, `${batch.root}/oracles/${fixtureId}.json`, pin.oracleSha256, `${label} fixture ${fixtureId} oracle`);
    problems.push(...manifest.problems, ...oracle.problems);
  }
  return { batch, problems };
}

/** Pins across batches: one path or pack ID has one hash, a pack ID one path and a path one pack ID. */
function pinConflicts(batches: readonly FrozenBatch[]): string[] {
  const problems: string[] = [];
  const byPath = new Map<string, PolicyPin>();
  const byPackId = new Map<string, PolicyPin>();
  for (const pin of batches.flatMap((batch) => [batch.policyPack, ...batch.policyInputs])) {
    const samePath = byPath.get(pin.path);
    if (samePath !== undefined && (samePath.sha256 !== pin.sha256 || samePath.packId !== pin.packId)) {
      problems.push(`policy path ${pin.path} is pinned to conflicting hashes or pack IDs`);
    }
    const samePack = byPackId.get(pin.packId);
    if (samePack !== undefined && samePack.sha256 !== pin.sha256) {
      problems.push(`pack ID ${pin.packId} is pinned to two hashes`);
    }
    if (samePack !== undefined && samePack.path !== pin.path) {
      problems.push(`pack ID ${pin.packId} is pinned at two paths`);
    }
    byPath.set(pin.path, samePath ?? pin);
    byPackId.set(pin.packId, samePack ?? pin);
  }
  return [...new Set(problems)];
}

/** Entry names of a real directory; `null` when nothing exists and `[]` for anything else, which the layout check reports. */
async function entries(fs: FileSystem, path: string): Promise<string[] | null> {
  const info = await lstatOrNull(fs, path);
  if (info === null) {
    return null;
  }
  return info.isDirectory() && !info.isSymbolicLink() ? (await fs.readdir(path)).sort() : [];
}

/** The whole suite inventory against the union of every registered batch. */
async function inventory(batches: readonly FrozenBatch[], fixtures: ReadonlyMap<string, PinnedFixture>, repoRoot: string, fs: FileSystem): Promise<string[]> {
  const problems: string[] = [];
  const suite = join(repoRoot, V2_SUITE_ROOT);
  const rootInfo = await lstatOrNull(fs, suite);
  if (rootInfo === null || !rootInfo.isDirectory() || rootInfo.isSymbolicLink()) {
    return [`suite root ${V2_SUITE_ROOT} does not exist or is not a directory`];
  }
  const top = (await entries(fs, suite)) ?? [];
  for (const name of top) {
    const info = await fs.lstat(join(suite, name));
    if (!SUITE_ENTRIES.has(name) || !info.isDirectory() || info.isSymbolicLink()) {
      problems.push(`${V2_SUITE_ROOT}/${name}: not part of the suite layout`);
    }
  }

  const directories = new Set<string>();
  for (const name of (await entries(fs, join(suite, 'fixtures'))) ?? []) {
    const info = await fs.lstat(join(suite, 'fixtures', name));
    if (!info.isDirectory() || info.isSymbolicLink()) {
      problems.push(`fixtures/${name}: not a fixture directory`);
    } else if (!fixtures.has(name)) {
      problems.push(`fixtures/${name}: fixture directory without a pin`);
    }
    directories.add(name);
  }
  const oracles = new Set<string>();
  for (const name of (await entries(fs, join(suite, 'oracles'))) ?? []) {
    const info = await fs.lstat(join(suite, 'oracles', name));
    const fixtureId = name.endsWith('.json') ? name.slice(0, -'.json'.length) : '';
    if (!info.isFile() || !fixtures.has(fixtureId)) {
      problems.push(`oracles/${name}: oracle without a pinned fixture`);
    }
    oracles.add(fixtureId);
  }
  for (const fixtureId of fixtures.keys()) {
    if (!directories.has(fixtureId)) {
      problems.push(`fixture ${fixtureId}: pin without a fixture directory`);
    }
    if (!oracles.has(fixtureId)) {
      problems.push(`fixture ${fixtureId}: pin without an oracle`);
    }
  }
  const inputs = new Set(batches.flatMap((batch) => batch.policyInputs.map((input) => input.path)));
  for (const name of (await entries(fs, join(suite, 'policy-inputs'))) ?? []) {
    if (!inputs.has(`${V2_SUITE_ROOT}/policy-inputs/${name}`)) {
      problems.push(`policy-inputs/${name}: negative policy input without a pin`);
    }
  }
  return problems;
}

/**
 * Validates the registered union: well-formed tables with distinct batch IDs,
 * one root and format pair, fixture IDs unique across batches (also under case
 * folding, since they name directories), consistent pins and an inventory that
 * matches the suite exactly.
 */
export async function checkUnion(
  candidates: readonly unknown[],
  repoRoot: string,
  fs: FileSystem = nodeFileSystem,
): Promise<{ batches: FrozenBatch[]; fixtures: Map<string, PinnedFixture>; problems: string[] }> {
  const problems: string[] = [];
  const batches: FrozenBatch[] = [];
  if (candidates.length === 0) {
    problems.push('no batch is registered');
  }
  candidates.forEach((candidate, index) => {
    const parsed = FrozenBatchSchema.safeParse(candidate);
    if (parsed.success) {
      batches.push(parsed.data);
    } else {
      problems.push(`registered batch ${index} is malformed: ${describeIssues(parsed.error)}`);
    }
  });
  const batchIds = new Set<string>();
  for (const batch of batches) {
    if (batchIds.has(batch.batchId)) {
      problems.push(`batch ID ${batch.batchId} is registered twice`);
    }
    batchIds.add(batch.batchId);
  }
  problems.push(...pinConflicts(batches));

  const fixtures = new Map<string, PinnedFixture>();
  const folded = new Map<string, string>();
  for (const batch of batches) {
    for (const [fixtureId, pin] of Object.entries(batch.fixtures)) {
      const previous = fixtures.get(fixtureId);
      const sameFolded = folded.get(fixtureId.toLowerCase());
      if (previous !== undefined) {
        problems.push(`fixture ${fixtureId} is pinned by batches ${previous.batchId} and ${batch.batchId}`);
        continue;
      }
      if (sameFolded !== undefined) {
        problems.push(`fixture ${fixtureId} differs from fixture ${sameFolded} only by letter case`);
        continue;
      }
      fixtures.set(fixtureId, { batchId: batch.batchId, fixtureId, ...pin });
      folded.set(fixtureId.toLowerCase(), fixtureId);
    }
  }
  problems.push(...(await contentFree(V2_SUITE_ROOT, () => inventory(batches, fixtures, repoRoot, fs), (problem) => [problem])));
  return { batches, fixtures, problems };
}

/**
 * The per-fixture trust audit: the fixture directory holds exactly
 * `manifest.json` and the files it lists, all regular files whose bytes match
 * their pins. It does not decide any input-boundary outcome.
 */
export async function auditFixtureFiles(repoRoot: string, fixtureId: string, fs: FileSystem = nodeFileSystem): Promise<string[]> {
  return contentFree(`fixtures/${fixtureId}`, () => auditFiles(repoRoot, fixtureId, fs), (problem) => [problem]);
}

async function auditFiles(repoRoot: string, fixtureId: string, fs: FileSystem): Promise<string[]> {
  const suite = join(repoRoot, V2_SUITE_ROOT);
  const read = await readManifest(suite, fixtureId, fs);
  if ('problems' in read) {
    return read.problems;
  }
  const problems: string[] = [];
  const onDisk: string[] = [];
  const walk = async (relative: string) => {
    for (const name of await fs.readdir(join(read.root, relative))) {
      const path = relative === '' ? name : `${relative}/${name}`;
      const info = await fs.lstat(join(read.root, path));
      if (info.isDirectory() && !info.isSymbolicLink() && path === 'documents') {
        await walk(path);
      } else if (info.isFile()) {
        onDisk.push(path);
      } else {
        problems.push(`fixtures/${fixtureId}/${path}: not a regular file`);
      }
    }
  };
  await walk('');
  const listed = new Map(read.manifest.files.map((file) => [file.path, file.sha256]));
  for (const path of onDisk.sort()) {
    if (path === 'manifest.json') {
      continue;
    }
    const pinned = listed.get(path);
    if (pinned === undefined) {
      problems.push(`fixtures/${fixtureId}/${path}: not listed in the manifest`);
    } else if (sha256(await fs.readFile(join(read.root, path))) !== pinned) {
      problems.push(`fixtures/${fixtureId}/${path}: SHA-256 differs from the manifest`);
    }
  }
  for (const path of listed.keys()) {
    if (!onDisk.includes(path)) {
      problems.push(`fixtures/${fixtureId}/${path}: listed in the manifest but missing`);
    }
  }
  return problems;
}
