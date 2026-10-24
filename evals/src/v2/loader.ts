import { dirname, join, resolve } from 'node:path';

import { compareCodeUnits, InputRejection, type RejectionReason } from '@pa/contracts';

import { contentFree, decodeUtf8, describeIssues, type FileInfo, type FileSystem, isLinkLoop, isMissing, isWithin, lstatOrNull, nodeFileSystem, sha256 } from './files.js';
import { scanJson } from './json-scan.js';
import { checkRecipeGraph, expandRecipes, metadataPath, payloadPath, predictPayloadSizes } from './recipes.js';
import { FixtureIdV2, FixtureManifestV2, isReservedSlot, MAX_DOCUMENTS, MAX_PAYLOAD_BYTES } from './schemas.js';

// The v2 fixture loader. It alone produces `input_boundary`
// rejections, in the frozen `pa.input-rejection.v1` envelope (D6). It counts
// every supplied slot first, from the manifest alone, before it expands a
// recipe, reads or hashes a payload. Otherwise it checks every attempted path
// under the canonical fixture root (symbolic links included) and every payload
// size, and reports all of those reasons together. It never opens a path
// outside the root. A malformed or tampered fixture is refused, which is not a
// rejection: nothing is loaded. It does not parse the case, metadata or bodies
// for acceptance; the pure domain owns the schema and snapshot stages.

export interface SlotEntry {
  slot: string;
  metadata: 'committed' | 'generated' | 'none';
  payload: 'committed' | 'generated' | 'none' | 'outside';
}

export interface LoadedDocument {
  slot: string;
  metadata: Uint8Array;
  /** `null` when the fixture supplies no payload for the slot. */
  payload: Uint8Array | null;
}

export interface LoadedFixture {
  fixtureId: string;
  manifest: FixtureManifestV2;
  manifestBytes: Uint8Array;
  caseBytes: Uint8Array;
  /** The explicit assessment argument, verbatim. */
  assessmentDate: string;
  /** Repository-relative path of the policy input; its bytes are pinned by the batch. */
  policyInputPath: string;
  /** In canonical slot order (UTF-16 code units). */
  documents: LoadedDocument[];
}

export type LoadOutcome =
  | { outcome: 'loaded'; fixture: LoadedFixture }
  | { outcome: 'rejected'; rejection: InputRejection }
  | { outcome: 'refused'; problems: string[] };

const refused = (...problems: string[]): LoadOutcome => ({ outcome: 'refused', problems });

/**
 * Pairs payloads and metadata by slot name from the manifest alone. File names
 * classify without ambiguity because no slot ends in `.meta` or `.template`
 * (N3). Identity is never derived from a name.
 */
export function planSlots(manifest: FixtureManifestV2): { slots: Map<string, SlotEntry>; problems: string[] } {
  const graph = checkRecipeGraph(manifest);
  const problems = [...graph.problems];
  const slots = new Map<string, SlotEntry>();
  const entry = (slot: string) => {
    const existing = slots.get(slot) ?? { slot, metadata: 'none' as const, payload: 'none' as const };
    slots.set(slot, existing);
    return existing;
  };

  for (const { path } of manifest.files) {
    if (path === 'case.json') {
      continue;
    }
    const name = path.slice('documents/'.length, -'.json'.length);
    if (name.endsWith('.template')) {
      continue;
    }
    const isMetadata = name.endsWith('.meta');
    const slot = isMetadata ? name.slice(0, -'.meta'.length) : name;
    if (isReservedSlot(slot)) {
      problems.push(`${path}: slot name ends in .meta or .template (N3)`);
      continue;
    }
    if (isMetadata) {
      entry(slot).metadata = 'committed';
    } else {
      entry(slot).payload = 'committed';
    }
  }
  for (const output of graph.outputs) {
    const target = entry(output.slot);
    if (output.role === 'metadata') {
      target.metadata = 'generated';
    } else if (target.payload === 'none') {
      target.payload = 'generated';
    }
  }
  for (const attempt of manifest.pathAttempts ?? []) {
    if (isReservedSlot(attempt.slot)) {
      problems.push(`path attempt ${attempt.slot}: slot name ends in .meta or .template (N3)`);
    } else if (slots.has(attempt.slot)) {
      problems.push(`path attempt ${attempt.slot}: shares its slot name with another slot`);
    } else {
      slots.set(attempt.slot, { slot: attempt.slot, metadata: 'none', payload: 'outside' });
    }
  }
  for (const slot of slots.values()) {
    if (slot.metadata === 'none' && slot.payload !== 'outside') {
      problems.push(`slot ${slot.slot}: payload without a metadata sidecar (orphan)`);
    }
  }
  return { slots, problems };
}

type Location = { kind: 'inside'; real: string; info: FileInfo } | { kind: 'outside' } | { kind: 'missing' };

/** Where a path really leads, resolving every symbolic link without opening anything. A link loop is unsafe. */
async function locate(fs: FileSystem, root: string, path: string): Promise<Location> {
  let real: string;
  try {
    real = await fs.realpath(path);
  } catch (error) {
    if (isLinkLoop(error)) {
      return { kind: 'outside' };
    }
    if (!isMissing(error)) {
      throw error;
    }
    // A dangling link is unsafe; an absent file is missing only if its directory is inside the root.
    if ((await lstatOrNull(fs, path))?.isSymbolicLink() === true) {
      return { kind: 'outside' };
    }
    try {
      return isWithin(root, await fs.realpath(dirname(path))) ? { kind: 'missing' } : { kind: 'outside' };
    } catch (parentError) {
      if (isMissing(parentError)) {
        return { kind: 'missing' };
      }
      if (isLinkLoop(parentError)) {
        return { kind: 'outside' };
      }
      throw parentError;
    }
  }
  return isWithin(root, real) ? { kind: 'inside', real, info: await fs.lstat(real) } : { kind: 'outside' };
}

/** The canonical fixture directory and its parsed manifest, or the refusal. */
export async function readManifest(
  suiteRoot: string,
  fixtureId: string,
  fs: FileSystem,
): Promise<{ root: string; manifest: FixtureManifestV2; bytes: Uint8Array } | { problems: string[] }> {
  if (!FixtureIdV2.safeParse(fixtureId).success) {
    return { problems: ['fixture ID is not a single safe path segment'] };
  }
  let suite: string;
  try {
    suite = await fs.realpath(suiteRoot);
  } catch (error) {
    if (isMissing(error)) {
      return { problems: ['suite root does not exist'] };
    }
    throw error;
  }
  const directory = join(suite, 'fixtures', fixtureId);
  const info = await lstatOrNull(fs, directory);
  if (info === null || !info.isDirectory() || info.isSymbolicLink()) {
    return { problems: [`fixtures/${fixtureId}: not a fixture directory`] };
  }
  const root = await fs.realpath(directory);
  if (!isWithin(suite, root)) {
    return { problems: [`fixtures/${fixtureId}: resolves outside the suite root`] };
  }
  const manifestInfo = await lstatOrNull(fs, join(root, 'manifest.json'));
  if (manifestInfo === null || !manifestInfo.isFile()) {
    return { problems: [`fixtures/${fixtureId}/manifest.json: missing or not a regular file`] };
  }
  const bytes = await fs.readFile(join(root, 'manifest.json'));
  const text = decodeUtf8(bytes);
  const scan = text === null ? null : scanJson(text);
  if (scan === null) {
    return { problems: [`fixtures/${fixtureId}/manifest.json: not UTF-8 JSON`] };
  }
  const manifest = FixtureManifestV2.safeParse(scan.value);
  if (!manifest.success) {
    return { problems: [`fixtures/${fixtureId}/manifest.json: ${describeIssues(manifest.error)}`] };
  }
  if (manifest.data.fixtureId !== fixtureId) {
    return { problems: [`fixtures/${fixtureId}/manifest.json: fixtureId differs from its directory`] };
  }
  return { root, manifest: manifest.data, bytes };
}

/** Loads one fixture of the suite as raw input bytes, or rejects it at the input boundary, or refuses it. */
export async function loadFixture(suiteRoot: string, fixtureId: string, fs: FileSystem = nodeFileSystem): Promise<LoadOutcome> {
  return contentFree(`fixtures/${fixtureId}`, () => load(suiteRoot, fixtureId, fs), (problem) => refused(problem));
}

async function load(suiteRoot: string, fixtureId: string, fs: FileSystem): Promise<LoadOutcome> {
  const read = await readManifest(suiteRoot, fixtureId, fs);
  if ('problems' in read) {
    return refused(...read.problems);
  }
  const { root, manifest } = read;
  const plan = planSlots(manifest);
  if (plan.problems.length > 0) {
    return refused(...plan.problems);
  }

  // 1. Count every supplied slot: committed, replicated, path attempts, current or superseded.
  if (plan.slots.size > MAX_DOCUMENTS) {
    return { outcome: 'rejected', rejection: InputRejection.parse({ schemaVersion: 'pa.input-rejection.v1', stage: 'input_boundary', reasons: [{ code: 'document_count_exceeded', documentRef: null, path: '/documents' }] }) };
  }

  // 2. Every attempted path and every payload size, reported together.
  let escaped = false;
  const oversized: string[] = [];
  const problems: string[] = [];
  const located = new Map<string, string>();
  const sizes = new Map<string, number>();
  for (const { path } of manifest.files) {
    const location = await locate(fs, root, join(root, path));
    if (location.kind === 'outside') {
      escaped = true;
    } else if (location.kind === 'missing') {
      problems.push(`${path}: listed in the manifest but missing`);
    } else if (!location.info.isFile()) {
      problems.push(`${path}: not a regular file`);
    } else {
      located.set(path, location.real);
      sizes.set(path, location.info.size);
    }
  }
  for (const attempt of manifest.pathAttempts ?? []) {
    const target = resolve(root, attempt.path);
    if (isWithin(root, target) && (await locate(fs, root, target)).kind !== 'outside') {
      problems.push(`path attempt ${attempt.slot}: does not leave the fixture root`);
    } else {
      escaped = true;
    }
  }
  if (problems.length > 0) {
    return refused(...problems);
  }
  const generated = predictPayloadSizes(manifest, (path) => sizes.get(path));
  for (const slot of plan.slots.values()) {
    const path = payloadPath(slot.slot);
    const size = slot.payload === 'committed' ? sizes.get(path) : slot.payload === 'generated' ? generated.get(path) : undefined;
    if (size !== undefined && size > MAX_PAYLOAD_BYTES) {
      oversized.push(`/documents/${slot.slot}/payload`);
    }
  }
  if (escaped || oversized.length > 0) {
    // Canonical reason order compares the whole path, not the slot name: `-` and `.` sort before `/`.
    const reasons: RejectionReason[] = [
      ...oversized.sort(compareCodeUnits).map((path) => ({ code: 'document_size_exceeded' as const, documentRef: null, path })),
      ...(escaped ? [{ code: 'path_outside_root' as const, documentRef: null, path: null }] : []),
    ];
    return { outcome: 'rejected', rejection: InputRejection.parse({ schemaVersion: 'pa.input-rejection.v1', stage: 'input_boundary', reasons }) };
  }

  // 3. Only now read the committed bytes, check their pins and expand the recipes.
  const bytes = new Map<string, Uint8Array>();
  for (const { path, sha256: pinned } of manifest.files) {
    const data = await fs.readFile(located.get(path) ?? join(root, path));
    if (sha256(data) !== pinned) {
      problems.push(`${path}: SHA-256 differs from the manifest`);
    }
    bytes.set(path, data);
  }
  if (problems.length > 0) {
    return refused(...problems);
  }
  const expansion = await expandRecipes(manifest, (path) => Promise.resolve(bytes.get(path) ?? new Uint8Array()));
  if (expansion.problems.length > 0) {
    return refused(...expansion.problems);
  }
  const fileOf = (path: string) => bytes.get(path) ?? expansion.outputs.get(path) ?? null;

  const documents = [...plan.slots.keys()].sort(compareCodeUnits).map((slot) => ({
    slot,
    metadata: fileOf(metadataPath(slot)) ?? new Uint8Array(),
    payload: fileOf(payloadPath(slot)),
  }));
  return {
    outcome: 'loaded',
    fixture: {
      fixtureId,
      manifest,
      manifestBytes: read.bytes,
      caseBytes: bytes.get('case.json') ?? new Uint8Array(),
      assessmentDate: manifest.assessmentDate,
      policyInputPath: manifest.policyInput.path,
      documents,
    },
  };
}

/**
 * The separately labelled recipe pin audit: expands every recipe of
 * a fixture within the resource bounds and checks every output pin, also for a
 * fixture whose loader outcome is a count or size rejection. It reads only
 * listed templates inside the fixture root and never feeds the loader.
 */
export async function auditFixtureRecipes(suiteRoot: string, fixtureId: string, fs: FileSystem = nodeFileSystem): Promise<{ recipes: number; verified: number; problems: string[] }> {
  return contentFree(`fixtures/${fixtureId}`, () => auditRecipes(suiteRoot, fixtureId, fs), (problem) => ({ recipes: 0, verified: 0, problems: [problem] }));
}

async function auditRecipes(suiteRoot: string, fixtureId: string, fs: FileSystem): Promise<{ recipes: number; verified: number; problems: string[] }> {
  const read = await readManifest(suiteRoot, fixtureId, fs);
  if ('problems' in read) {
    return { recipes: 0, verified: 0, problems: read.problems };
  }
  const recipes = read.manifest.recipes ?? [];
  if (recipes.length === 0) {
    return { recipes: 0, verified: 0, problems: [] };
  }
  const pins = new Map(read.manifest.files.map((file) => [file.path, file.sha256]));
  const templateProblems: string[] = [];
  const expansion = await expandRecipes(read.manifest, async (path) => {
    const location = await locate(fs, read.root, join(read.root, path));
    if (location.kind !== 'inside' || !location.info.isFile()) {
      templateProblems.push(`${path}: template is not a regular file inside the fixture root`);
      return new Uint8Array();
    }
    const data = await fs.readFile(location.real);
    if (sha256(data) !== pins.get(path)) {
      templateProblems.push(`${path}: SHA-256 differs from the manifest`);
    }
    return data;
  });
  return { recipes: recipes.length, verified: expansion.verified, problems: [...templateProblems, ...expansion.problems] };
}
