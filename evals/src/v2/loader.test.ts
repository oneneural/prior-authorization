import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { type FileSystem, nodeFileSystem } from './files.js';
import { loadFixture, type LoadOutcome } from './loader.js';
import { MAX_PAYLOAD_BYTES } from './schemas.js';
import { type DocumentSpec, digest, type FixtureSpec, json, makeTempDir, metadata, noteBody, recordingFs, removeTempDirs, writeFixture, writeTree } from './test-support.js';

// The loader's input boundary (D6 and the F26 conventions): count first, then
// every path and payload size together, never opening an outside path. Each
// fixture is a temporary directory; outside sentinels hold text that must never
// be read or echoed.

afterAll(removeTempDirs);

const SENTINEL = 'OUTSIDE-SENTINEL-NEVER-READ';

const restricted = (count: number, prefix = 't-r'): Record<string, DocumentSpec> =>
  Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}${index + 1}.v1`, { meta: metadata(`${prefix}${index + 1}`, 1, 'order', null) }]));

const available = (documentId: string, payload: string | Uint8Array): Record<string, DocumentSpec> => ({
  [`${documentId}.v1`]: { meta: metadata(documentId, 1, 'supporting_note', payload), payload },
});

async function setup(spec: Omit<FixtureSpec, 'fixtureId'> & { fixtureId?: string }) {
  const base = await makeTempDir();
  const suite = join(base, 'suite');
  const outside = join(base, 'outside');
  await writeTree(outside, { 'sentinel.json': SENTINEL });
  const fixtureId = spec.fixtureId ?? 'F26t';
  await writeFixture(suite, { ...spec, fixtureId });
  return { base, suite, outside, fixtureId, dir: join(suite, 'fixtures', fixtureId) };
}

const reasonsOf = (outcome: LoadOutcome) => (outcome.outcome === 'rejected' ? outcome.rejection.reasons : outcome);
const reason = (code: string, path: string | null) => ({ code, documentRef: null, path });

describe('document count, checked first', () => {
  it('allows 50 supplied documents', async () => {
    const { suite, fixtureId } = await setup({ documents: restricted(50) });
    const outcome = await loadFixture(suite, fixtureId);
    expect(outcome.outcome).toBe('loaded');
    expect(outcome.outcome === 'loaded' && outcome.fixture.documents.length).toBe(50);
  });

  it('rejects 51 with only document_count_exceeded, before any path, size or payload access', async () => {
    const big = 'é'.repeat(600_000);
    const { suite, fixtureId, dir } = await setup({
      documents: { ...restricted(49), ...available('t-big', big) },
      manifest: { pathAttempts: [{ slot: 'outside.v1', path: '../../../outside/sentinel.json' }] },
    });
    const { fs, calls } = recordingFs();
    const outcome = await loadFixture(suite, fixtureId, fs);
    expect(reasonsOf(outcome)).toEqual([reason('document_count_exceeded', '/documents')]);
    expect(calls.filter((call) => call.path.includes(`${dir}/documents`) || call.path.includes('outside'))).toEqual([]);
    expect(calls.filter((call) => call.op === 'readFile').map((call) => call.path)).toEqual([join(dir, 'manifest.json')]);
  });

  it('counts replicated copies without expanding the recipe or reading its templates', async () => {
    const outputs = Array.from({ length: 2 }, (_, index) => ({ slot: `t-copy-${index + 1}.v1`, metadataSha256: digest(`unused ${index}`) }));
    const { suite, fixtureId } = await setup({
      documents: restricted(49),
      extraFiles: { 'documents/t-copy.payload.template.json': json(noteBody()), 'documents/t-copy.meta.template.json': '{}' },
      manifest: {
        recipes: [{ recipe: 'replicate', payload: 'documents/t-copy.payload.template.json', metadataTemplate: 'documents/t-copy.meta.template.json', placeholder: '@@N@@', count: 2, width: 1, outputs }],
      },
    });
    const { fs, calls } = recordingFs();
    expect(reasonsOf(await loadFixture(suite, fixtureId, fs))).toEqual([reason('document_count_exceeded', '/documents')]);
    expect(calls.filter((call) => call.path.includes('template'))).toEqual([]);
  });

  it('does not count templates or metadata sidecars as documents', async () => {
    const { suite, fixtureId } = await setup({ documents: restricted(50), extraFiles: { 'documents/t-unused.template.json': '{}' } });
    expect((await loadFixture(suite, fixtureId)).outcome).toBe('loaded');
  });
});

describe('payload size in raw bytes', () => {
  it('allows exactly 1,048,576 bytes of multibyte UTF-8 and rejects 1,048,577', async () => {
    const exact = 'é'.repeat(MAX_PAYLOAD_BYTES / 2);
    expect(Buffer.byteLength(exact)).toBe(1_048_576);
    const allowed = await setup({ documents: available('t-big', exact) });
    expect((await loadFixture(allowed.suite, allowed.fixtureId)).outcome).toBe('loaded');
    const over = await setup({ documents: available('t-big', `${exact}a`) });
    expect(reasonsOf(await loadFixture(over.suite, over.fixtureId))).toEqual([reason('document_size_exceeded', '/documents/t-big.v1/payload')]);
  });

  it('measures bytes, not characters', async () => {
    const text = 'é'.repeat(600_000);
    expect(text.length).toBeLessThan(MAX_PAYLOAD_BYTES);
    const { suite, fixtureId } = await setup({ documents: available('t-wide', text) });
    expect(reasonsOf(await loadFixture(suite, fixtureId))).toEqual([reason('document_size_exceeded', '/documents/t-wide.v1/payload')]);
  });

  it('excludes metadata sidecars and the manifest from the limit', async () => {
    const payload = json(noteBody());
    const { suite, fixtureId } = await setup({ documents: { 't-note.v1': { meta: `${json(metadata('t-note', 1, 'supporting_note', payload))}${' '.repeat(1_100_000)}`, payload } } });
    expect((await loadFixture(suite, fixtureId)).outcome).toBe('loaded');
  });

  it('orders size reasons by the whole payload path in UTF-16 code units, not by slot name', async () => {
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
    // '-' (0x2D) and '.' (0x2E) sort before '/' (0x2F), so a slot that prefixes another sorts last.
    const { suite, fixtureId } = await setup({
      documents: { ...available('t-big', big), 't-big.v1-b': { meta: metadata('t-big', 2, 'supporting_note', big), payload: big }, 't-big.v1.dup1': { meta: metadata('t-big', 1, 'supporting_note', big), payload: big } },
      manifest: { pathAttempts: [{ slot: 'outside.v1', path: '../outside.json' }] },
    });
    expect(reasonsOf(await loadFixture(suite, fixtureId))).toEqual([
      reason('document_size_exceeded', '/documents/t-big.v1-b/payload'),
      reason('document_size_exceeded', '/documents/t-big.v1.dup1/payload'),
      reason('document_size_exceeded', '/documents/t-big.v1/payload'),
      reason('path_outside_root', null),
    ]);
  });

  it('reports every oversized payload with the path reason, in canonical order', async () => {
    const big = 'x'.repeat(MAX_PAYLOAD_BYTES + 1);
    const { suite, fixtureId } = await setup({
      documents: { ...available('t-b', big), ...available('t-a', big), ...available('t-small', 'x') },
      manifest: { pathAttempts: [{ slot: 'outside.v1', path: '../outside.json' }] },
    });
    expect(reasonsOf(await loadFixture(suite, fixtureId))).toEqual([
      reason('document_size_exceeded', '/documents/t-a.v1/payload'),
      reason('document_size_exceeded', '/documents/t-b.v1/payload'),
      reason('path_outside_root', null),
    ]);
  });

  it('sizes a generated payload from targetBytes without expanding its recipe', async () => {
    const template = '{"text": "@@PAD@@"}\n';
    const { suite, fixtureId } = await setup({
      documents: { 't-pad.v1': { meta: metadata('t-pad', 1, 'supporting_note', 'unused') } },
      extraFiles: { 'documents/t-pad.template.json': template },
      manifest: { recipes: [{ recipe: 'pad', template: 'documents/t-pad.template.json', placeholder: '@@PAD@@', fill: 'a', targetBytes: MAX_PAYLOAD_BYTES + 1, output: 'documents/t-pad.v1.json', sha256: digest('unused') }] },
    });
    const { fs, calls } = recordingFs();
    expect(reasonsOf(await loadFixture(suite, fixtureId, fs))).toEqual([reason('document_size_exceeded', '/documents/t-pad.v1/payload')]);
    expect(calls.filter((call) => call.op === 'readFile' && call.path.includes('template'))).toEqual([]);
  });
});

describe('paths under the canonical fixture root', () => {
  it('reports one path_outside_root however many path attempts escape, without touching them', async () => {
    const base = await makeTempDir();
    const { suite, fixtureId } = await setup({
      documents: available('t-note', json(noteBody())),
      manifest: {
        pathAttempts: [
          { slot: 'outside-a.v1', path: '../../outside/sentinel.json' },
          { slot: 'outside-b.v1', path: join(base, 'absolute', 'sentinel.json') },
        ],
      },
    });
    const { fs, calls } = recordingFs();
    const outcome = await loadFixture(suite, fixtureId, fs);
    expect(reasonsOf(outcome)).toEqual([reason('path_outside_root', null)]);
    expect(calls.filter((call) => call.path.includes('outside') || call.path.startsWith(base))).toEqual([]);
  });

  it('treats a symbolic link loop as an escape, not an error', async () => {
    const { suite, fixtureId, dir } = await setup({ documents: available('t-loop', json(noteBody())) });
    const target = join(dir, 'documents', 't-loop.v1.json');
    await rm(target);
    await symlink('t-loop-b.json', target);
    await symlink('t-loop.v1.json', join(dir, 'documents', 't-loop-b.json'));
    expect(reasonsOf(await loadFixture(suite, fixtureId))).toEqual([reason('path_outside_root', null)]);
  });

  it('rejects a symbolic link to an outside file without reading it or echoing it', async () => {
    const { suite, fixtureId, dir, outside, base } = await setup({ documents: { 't-link.v1': { meta: metadata('t-link', 1, 'supporting_note', SENTINEL), payload: SENTINEL } } });
    await rm(join(dir, 'documents', 't-link.v1.json'));
    await symlink(join(outside, 'sentinel.json'), join(dir, 'documents', 't-link.v1.json'));
    const { fs, calls } = recordingFs();
    const outcome = await loadFixture(suite, fixtureId, fs);
    expect(reasonsOf(outcome)).toEqual([reason('path_outside_root', null)]);
    expect(calls.filter((call) => call.op === 'readFile' && call.path !== join(dir, 'manifest.json'))).toEqual([]);
    const text = JSON.stringify(outcome);
    expect(text).not.toContain(base);
    expect(text).not.toContain(SENTINEL);
  });

  it('rejects a symbolically linked documents directory and a dangling link', async () => {
    const payload = json(noteBody());
    const linked = await setup({ documents: available('t-note', payload) });
    await writeTree(linked.outside, { 'documents/t-note.v1.json': payload, 'documents/t-note.v1.meta.json': json(metadata('t-note', 1, 'supporting_note', payload)) });
    await rm(join(linked.dir, 'documents'), { recursive: true });
    await symlink(join(linked.outside, 'documents'), join(linked.dir, 'documents'));
    expect(reasonsOf(await loadFixture(linked.suite, linked.fixtureId))).toEqual([reason('path_outside_root', null)]);

    const dangling = await setup({ documents: available('t-note', payload) });
    await rm(join(dangling.dir, 'documents', 't-note.v1.json'));
    await symlink(join(dangling.outside, 'missing.json'), join(dangling.dir, 'documents', 't-note.v1.json'));
    expect(reasonsOf(await loadFixture(dangling.suite, dangling.fixtureId))).toEqual([reason('path_outside_root', null)]);
  });

  it('rejects a lexically inside path attempt that leads outside through a link', async () => {
    const { suite, fixtureId, dir, outside } = await setup({ documents: available('t-note', json(noteBody())), manifest: { pathAttempts: [{ slot: 'via-link.v1', path: 'links/escape.json' }] } });
    await mkdir(join(dir, 'links'));
    await symlink(join(outside, 'sentinel.json'), join(dir, 'links', 'escape.json'));
    const { fs, calls } = recordingFs();
    expect(reasonsOf(await loadFixture(suite, fixtureId, fs))).toEqual([reason('path_outside_root', null)]);
    expect(calls.filter((call) => call.op === 'readFile' && call.path.includes('escape'))).toEqual([]);
  });

  it('follows an in-root symbolic link and loads the exact target bytes', async () => {
    const payload = json(noteBody('Linked inside the root.'));
    const { suite, fixtureId, dir } = await setup({ documents: available('t-note', payload) });
    await writeFile(join(dir, 'store.json'), payload);
    await rm(join(dir, 'documents', 't-note.v1.json'));
    await symlink('../store.json', join(dir, 'documents', 't-note.v1.json'));
    const outcome = await loadFixture(suite, fixtureId);
    expect(outcome.outcome === 'loaded' && Buffer.from(outcome.fixture.documents[0]?.payload ?? []).toString('utf8')).toBe(payload);
  });

  it('refuses a path attempt that does not leave the fixture root', async () => {
    const { suite, fixtureId } = await setup({ documents: available('t-note', json(noteBody())), manifest: { pathAttempts: [{ slot: 'inside.v1', path: 'documents/t-note.v1.json' }] } });
    expect(await loadFixture(suite, fixtureId)).toEqual({ outcome: 'refused', problems: ['path attempt inside.v1: does not leave the fixture root'] });
  });
});

describe('fixture refusals', () => {
  it('refuses slot names ending in .meta or .template before reading any payload (N3)', async () => {
    const payload = json(noteBody());
    const reserved: Record<string, string>[] = [
      { 'documents/t-a.meta.meta.json': json(metadata('t-a', 1, 'supporting_note', payload)) },
      { 'documents/t-a.template.meta.json': json(metadata('t-a', 1, 'supporting_note', payload)) },
    ];
    for (const files of reserved) {
      const { suite, fixtureId, dir } = await setup({ documents: available('t-ok', payload), extraFiles: files });
      const { fs, calls } = recordingFs();
      const outcome = await loadFixture(suite, fixtureId, fs);
      expect(outcome.outcome === 'refused' && outcome.problems.join()).toContain('ends in .meta or .template (N3)');
      expect(calls.filter((call) => call.op === 'readFile').map((call) => call.path)).toEqual([join(dir, 'manifest.json')]);
    }
    const attempt = await setup({ documents: available('t-ok', payload), manifest: { pathAttempts: [{ slot: 'x.meta', path: '../x.json' }] } });
    expect(await loadFixture(attempt.suite, attempt.fixtureId)).toEqual({ outcome: 'refused', problems: ['path attempt x.meta: slot name ends in .meta or .template (N3)'] });
  });

  it('refuses an orphan payload, a colliding path attempt and a malformed recipe', async () => {
    const orphan = await setup({ documents: { 't-orphan.v1': { payload: json(noteBody()) } } });
    expect(await loadFixture(orphan.suite, orphan.fixtureId)).toEqual({ outcome: 'refused', problems: ['slot t-orphan.v1: payload without a metadata sidecar (orphan)'] });

    const collision = await setup({ documents: available('t-note', json(noteBody())), manifest: { pathAttempts: [{ slot: 't-note.v1', path: '../x.json' }] } });
    expect(await loadFixture(collision.suite, collision.fixtureId)).toEqual({ outcome: 'refused', problems: ['path attempt t-note.v1: shares its slot name with another slot'] });

    const recipe = await setup({ documents: restricted(1), manifest: { recipes: [{ recipe: 'replicate', payload: 'documents/x.template.json', metadataTemplate: 'documents/y.template.json', placeholder: '@', count: 2, width: 1, outputs: [] }] } });
    const outcome = await loadFixture(recipe.suite, recipe.fixtureId);
    expect(outcome.outcome === 'refused' && outcome.problems.join()).toContain('outputs must pin exactly count copies');
  });

  it('refuses missing or changed listed bytes and a mismatched manifest identity', async () => {
    const missing = await setup({ documents: available('t-note', json(noteBody())) });
    await rm(join(missing.dir, 'documents', 't-note.v1.json'));
    expect(await loadFixture(missing.suite, missing.fixtureId)).toEqual({ outcome: 'refused', problems: ['documents/t-note.v1.json: listed in the manifest but missing'] });

    const changed = await setup({ documents: available('t-note', json(noteBody())) });
    await writeFile(join(changed.dir, 'documents', 't-note.v1.json'), json(noteBody('Changed by one test.')));
    expect(await loadFixture(changed.suite, changed.fixtureId)).toEqual({ outcome: 'refused', problems: ['documents/t-note.v1.json: SHA-256 differs from the manifest'] });

    const renamed = await setup({ documents: restricted(1), manifest: { fixtureId: 'F26u' } });
    expect(await loadFixture(renamed.suite, renamed.fixtureId)).toEqual({ outcome: 'refused', problems: ['fixtures/F26t/manifest.json: fixtureId differs from its directory'] });

    const unknown = await setup({ documents: restricted(1), manifest: { surprise: true } });
    const outcome = await loadFixture(unknown.suite, unknown.fixtureId);
    expect(outcome.outcome === 'refused' && outcome.problems.join()).toContain('Unrecognized key');
    expect((await loadFixture(unknown.suite, '../F26t')).outcome).toBe('refused');
    expect((await loadFixture(unknown.suite, 'F99')).outcome).toBe('refused');
  });
});

describe('loaded input', () => {
  it('returns raw bytes in canonical slot order, with no payload for a restricted slot', async () => {
    const payload = json(noteBody());
    const { suite, fixtureId } = await setup({ documents: { ...available('t-b', payload), ...restricted(1, 't-a') }, manifest: { assessmentDate: 'not-a-date' } });
    const outcome = await loadFixture(suite, fixtureId);
    if (outcome.outcome !== 'loaded') {
      throw new Error(outcome.outcome);
    }
    expect(outcome.fixture.documents.map((document) => [document.slot, document.payload === null])).toEqual([
      ['t-a1.v1', true],
      ['t-b.v1', false],
    ]);
    expect(Buffer.from(outcome.fixture.documents[1]?.payload ?? []).toString('utf8')).toBe(payload);
    // The explicit assessment argument is passed verbatim; its validity is the domain's schema stage.
    expect(outcome.fixture.assessmentDate).toBe('not-a-date');
  });
});

describe('unexpected file system errors', () => {
  it('become one content-free refusal naming only the fixture and the error code', async () => {
    const { suite, fixtureId, base } = await setup({ documents: available('t-note', json(noteBody())) });
    const denied: FileSystem = {
      ...nodeFileSystem,
      realpath: (path) => (path.includes(`${sep}documents${sep}`) ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, realpath '${path}'`), { code: 'EACCES' })) : nodeFileSystem.realpath(path)),
    };
    const outcome = await loadFixture(suite, fixtureId, denied);
    expect(outcome).toEqual({ outcome: 'refused', problems: ['fixtures/F26t: unexpected file system error (EACCES)'] });
    expect(JSON.stringify(outcome)).not.toContain(base);
  });

  it('still throw for a defect that is not a system error', async () => {
    const { suite, fixtureId } = await setup({ documents: available('t-note', json(noteBody())) });
    const broken: FileSystem = { ...nodeFileSystem, lstat: () => Promise.reject(new TypeError('defect')) };
    await expect(loadFixture(suite, fixtureId, broken)).rejects.toThrow('defect');
  });
});
