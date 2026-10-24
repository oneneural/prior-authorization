import { createHash } from 'node:crypto';

import { DocumentExact } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { checkRecipeGraph, expandRecipes } from './recipes.js';
import { FixtureManifestV2, MAX_GENERATED_BYTES, MAX_TARGET_BYTES } from './schemas.js';
import { json, metadata, noteBody } from './test-support.js';

// The closed recipe grammar with the approved recipe readings. Expected bytes are built
// by hand in each test and hashed here with node:crypto, independently of the
// implementation's own hash helper. Nothing is written to disk.

const audit = (bytes: string | Uint8Array) => createHash('sha256').update(bytes).digest('hex');

type Files = Record<string, string | Uint8Array>;

function manifestOf(files: Files, recipes: unknown[]) {
  return FixtureManifestV2.parse({
    schemaVersion: 'pa.fixture-manifest.v2',
    fixtureId: 'F26r',
    specFixtureRow: 'F26',
    title: 'Recipe test',
    scenario: 'Synthetic recipe test.',
    syntheticProvenance: 'Original synthetic data built in code.',
    assessmentDate: '2026-10-18',
    policyInput: { path: 'policy-packs/lab-k0823-jd-20261018-v2.json', sha256: audit('pack') },
    coverage: ['F26'],
    files: [{ path: 'case.json', sha256: audit('{}') }, ...Object.entries(files).map(([path, bytes]) => ({ path, sha256: audit(bytes) }))],
    recipes,
  });
}

async function expand(files: Files, recipes: unknown[]) {
  return expandRecipes(manifestOf(files, recipes), (path) => Promise.resolve(Buffer.from(files[path] ?? '')));
}

const TEMPLATE = '{\n  "title": "Synthetic padding",\n  "text": "start @@PAD@@ end"\n}\n';
const BASE = Buffer.byteLength(TEMPLATE) - '@@PAD@@'.length;
const padded = (fill: string, repetitions: number) => TEMPLATE.replace('@@PAD@@', fill.repeat(repetitions));
const pad = (fill: string, targetBytes: number, sha256: string, template = 'documents/t-pad.template.json', output = 'documents/t-pad.v1.json') => ({
  recipe: 'pad',
  template,
  placeholder: '@@PAD@@',
  fill,
  targetBytes,
  output,
  sha256,
});

describe('pad', () => {
  it('replaces the one placeholder with whole repetitions and preserves every other byte', async () => {
    for (const [fill, repetitions] of [
      ['é', 100],
      ['a', 3],
      ['😀', 5],
      ['ab€d', 2],
      ['abcdefgh', 1],
    ] as const) {
      const expected = padded(fill, repetitions);
      const result = await expand({ 'documents/t-pad.template.json': TEMPLATE }, [pad(fill, Buffer.byteLength(expected), audit(expected))]);
      expect(result.problems, fill).toEqual([]);
      expect(Buffer.from(result.outputs.get('documents/t-pad.v1.json') ?? []).toString('utf8')).toBe(expected);
    }
  });

  it('counts the 1 MiB boundary in bytes with a multibyte fill', async () => {
    for (const target of [1_048_576, 1_048_577]) {
      const fill = target % 2 === BASE % 2 ? 'é' : 'a';
      const expected = padded(fill, (target - BASE) / Buffer.byteLength(fill));
      const result = await expand({ 'documents/t-pad.template.json': TEMPLATE }, [pad(fill, target, audit(expected))]);
      expect(result.problems).toEqual([]);
      expect(result.outputs.get('documents/t-pad.v1.json')?.length).toBe(target);
    }
  });

  it('accepts zero repetitions and the 2,097,152-byte target, and refuses one above before allocation', async () => {
    const empty = padded('a', 0);
    expect((await expand({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', BASE, audit(empty))])).problems).toEqual([]);
    const largest = padded('a', MAX_TARGET_BYTES - BASE);
    expect((await expand({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', MAX_TARGET_BYTES, audit(largest))])).problems).toEqual([]);
    expect(() => manifestOf({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', MAX_TARGET_BYTES + 1, audit(''))])).toThrow();
    expect(() => manifestOf({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', 0, audit(''))])).toThrow();
    expect(() => manifestOf({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', 10.5, audit(''))])).toThrow();
  });

  it('refuses impossible targets', async () => {
    const files = { 'documents/t-pad.template.json': TEMPLATE };
    expect((await expand(files, [pad('a', BASE - 1, audit(''))])).problems).toEqual(['recipe 0 (pad): targetBytes is smaller than the template without its placeholder']);
    expect((await expand(files, [pad('é', BASE + 3, audit(''))])).problems).toEqual(['recipe 0 (pad): targetBytes is not reachable by whole repetitions of fill']);
    expect((await expand(files, [pad('😀', BASE + 6, audit(''))])).problems).toEqual(['recipe 0 (pad): targetBytes is not reachable by whole repetitions of fill']);
  });

  it('refuses missing, repeated and misplaced placeholders', async () => {
    const run = (template: string, placeholder = '@@PAD@@') =>
      expand({ 'documents/t-pad.template.json': template }, [{ ...pad('a', Buffer.byteLength(template) + 10, audit('')), placeholder }]).then((result) => result.problems);
    expect(await run('{"text": "none"}')).toEqual(['recipe 0 (pad): template holds 0 placeholder occurrences, not exactly one']);
    // The placeholder count is reported before any target check.
    const unreachable = await expand({ 'documents/t-pad.template.json': '{"text": "none"}' }, [pad('é', 1, audit(''))]);
    expect(unreachable.problems).toEqual(['recipe 0 (pad): template holds 0 placeholder occurrences, not exactly one']);
    expect(await run('{"a": "@@PAD@@", "b": "@@PAD@@"}')).toEqual(['recipe 0 (pad): template holds 2 placeholder occurrences, not exactly one']);
    expect(await run('{"text": "@@@"}', '@@')).toEqual(['recipe 0 (pad): template holds 2 placeholder occurrences, not exactly one']);
    expect(await run('{"@@PAD@@": "value"}')).toEqual(['recipe 0 (pad): the placeholder is not inside one JSON string value']);
    expect(await run('{"n": @@PAD@@}')).toEqual(['recipe 0 (pad): the placeholder is not inside one JSON string value']);
    expect(await run('{"text": "x\\u0041@@"}', '0041@@')).toEqual(['recipe 0 (pad): the placeholder is not inside one JSON string value']);
    expect(await run('{"text": "x\\n@@"}', 'n@@')).toEqual(['recipe 0 (pad): the placeholder is not inside one JSON string value']);
  });

  it('refuses invalid fills and a bad output pin', async () => {
    for (const fill of ['', '123456789', '"', '\\', '\u0007', '\u007f', '\u0085', '\ud800', 'a\udc00']) {
      expect(() => manifestOf({ 'documents/t-pad.template.json': TEMPLATE }, [pad(fill, BASE + 1, audit(''))]), JSON.stringify(fill)).toThrow();
    }
    const result = await expand({ 'documents/t-pad.template.json': TEMPLATE }, [pad('a', BASE + 1, audit('wrong'))]);
    expect(result.problems).toEqual(['recipe 0 (pad): output documents/t-pad.v1.json SHA-256 differs from its pin']);
  });

  it('refuses a template that is not valid UTF-8', async () => {
    const bytes = Buffer.concat([Buffer.from('{"text": "@@PAD@@ '), Buffer.from([0xc3]), Buffer.from('"}')]);
    expect((await expand({ 'documents/t-pad.template.json': bytes }, [pad('a', bytes.length + 1, audit(''))])).problems).toEqual(['recipe 0 (pad): template is not valid UTF-8']);
  });
});

const PAYLOAD = json(noteBody('Replicated payload.'));
const metaTemplate = (documentId = 't-copy-@@N@@', extra: Record<string, unknown> = {}) =>
  json({ ...metadata(documentId, 1, 'supporting_note', PAYLOAD), syntheticProvenance: { origin: 'authored_synthetic', statement: 'Copy @@N@@ of a synthetic payload.' }, ...extra });
const REPLICATE_FILES = { 'documents/t-copy.payload.template.json': PAYLOAD, 'documents/t-copy.meta.template.json': metaTemplate() };

/** Hand-rendered outputs: every occurrence of the placeholder replaced by the zero-padded index. */
const rendered = (template: string, count: number, width: number, placeholder = '@@N@@') =>
  Array.from({ length: count }, (_, index) => template.replaceAll(placeholder, String(index + 1).padStart(width, '0')));

const replicate = (count: number, width: number, outputs: { slot: string; metadataSha256: string }[], overrides: Record<string, unknown> = {}) => ({
  recipe: 'replicate',
  payload: 'documents/t-copy.payload.template.json',
  metadataTemplate: 'documents/t-copy.meta.template.json',
  placeholder: '@@N@@',
  count,
  width,
  outputs,
  ...overrides,
});

const pinsFor = (template: string, count: number, width: number) =>
  rendered(template, count, width).map((text) => {
    const meta = DocumentExact.parse(JSON.parse(text));
    return { slot: `${meta.documentId}.v${meta.version}`, metadataSha256: audit(text) };
  });

describe('replicate', () => {
  it('renders every copy in index order with every placeholder substituted and the payload byte-for-byte', async () => {
    const outputs = pinsFor(metaTemplate(), 3, 2);
    expect(outputs.map((output) => output.slot)).toEqual(['t-copy-01.v1', 't-copy-02.v1', 't-copy-03.v1']);
    const result = await expand(REPLICATE_FILES, [replicate(3, 2, outputs)]);
    expect(result.problems).toEqual([]);
    expect(result.verified).toBe(3);
    const texts = rendered(metaTemplate(), 3, 2);
    outputs.forEach((output, index) => {
      expect(Buffer.from(result.outputs.get(`documents/${output.slot}.meta.json`) ?? []).toString('utf8')).toBe(texts[index]);
      expect(Buffer.from(result.outputs.get(`documents/${output.slot}.json`) ?? []).toString('utf8')).toBe(PAYLOAD);
    });
    expect(texts[1]).toContain('Copy 02 of a synthetic payload.');
    // The literal payload contentHash is preserved in every copy.
    expect(new Set(texts.map((text) => (JSON.parse(text) as { contentHash: string }).contentHash))).toEqual(new Set([audit(PAYLOAD)]));
  });

  it('treats width as a minimum: width 9 with one copy and width 1 with 51 copies are valid', async () => {
    const nine = pinsFor(metaTemplate(), 1, 9);
    expect(nine.map((output) => output.slot)).toEqual(['t-copy-000000001.v1']);
    expect((await expand(REPLICATE_FILES, [replicate(1, 9, nine)])).problems).toEqual([]);
    const many = pinsFor(metaTemplate(), 51, 1);
    expect(many.at(9)?.slot).toBe('t-copy-10.v1');
    expect(new Set(many.map((output) => output.slot)).size).toBe(51);
    expect((await expand(REPLICATE_FILES, [replicate(51, 1, many)])).problems).toEqual([]);
  });

  it('accepts count 1 and 64 and refuses 0, 65 and a mismatched outputs list', () => {
    expect(() => manifestOf(REPLICATE_FILES, [replicate(64, 2, pinsFor(metaTemplate(), 64, 2))])).not.toThrow();
    expect(() => manifestOf(REPLICATE_FILES, [replicate(0, 2, [])])).toThrow();
    expect(() => manifestOf(REPLICATE_FILES, [replicate(65, 2, pinsFor(metaTemplate(), 65, 2))])).toThrow();
    expect(() => manifestOf(REPLICATE_FILES, [replicate(3, 2, pinsFor(metaTemplate(), 2, 2))])).toThrow();
    expect(() => manifestOf(REPLICATE_FILES, [replicate(2, 0, pinsFor(metaTemplate(), 2, 2))])).toThrow();
    const twice = pinsFor(metaTemplate(), 1, 2);
    expect(() => manifestOf(REPLICATE_FILES, [replicate(2, 2, [...twice, ...twice])])).toThrow();
  });

  it('refuses reordered, duplicate, invalid, hash-changing and mispinned copies', async () => {
    const outputs = pinsFor(metaTemplate(), 2, 2);
    expect((await expand(REPLICATE_FILES, [replicate(2, 2, [...outputs].reverse())])).problems).toEqual(['recipe 0 (replicate): copy 1 renders slot t-copy-01.v1, which differs from outputs[0]']);

    const sameId = { ...REPLICATE_FILES, 'documents/t-copy.meta.template.json': metaTemplate('t-copy') };
    expect((await expand(sameId, [replicate(2, 2, [{ slot: 't-copy.v1', metadataSha256: audit('a') }, { slot: 't-copy-b.v1', metadataSha256: audit('b') }])])).problems[0]).toContain('copy 1 metadata SHA-256 differs');
    const sameIdPinned = rendered(metaTemplate('t-copy'), 2, 2).map((text, index) => ({ slot: index === 0 ? 't-copy.v1' : 't-copy-b.v1', metadataSha256: audit(text) }));
    expect((await expand(sameId, [replicate(2, 2, sameIdPinned)])).problems).toEqual(["recipe 0 (replicate): copy 2 repeats an earlier copy's document ID"]);

    const versioned = { ...REPLICATE_FILES, 'documents/t-copy.meta.template.json': metaTemplate().replace('"version": 1', '"version": @@N@@') };
    expect((await expand(versioned, [replicate(1, 2, [{ slot: 't-copy-01.v1', metadataSha256: audit('x') }])])).problems[0]).toContain('copy 1 metadata is not valid pa.document.v1');

    const hashed = { ...REPLICATE_FILES, 'documents/t-copy.meta.template.json': metaTemplate().replace(audit(PAYLOAD), `${audit(PAYLOAD).slice(0, 62)}@@N@@`) };
    const hashedPins = rendered(hashed['documents/t-copy.meta.template.json'], 2, 2).map((text, index) => ({ slot: `t-copy-0${index + 1}.v1`, metadataSha256: audit(text) }));
    expect((await expand(hashed, [replicate(2, 2, hashedPins)])).problems).toEqual(['recipe 0 (replicate): copy 2 changes the literal contentHash']);

    const wrong = outputs.map((output, index) => (index === 1 ? { ...output, metadataSha256: audit('wrong') } : output));
    expect((await expand(REPLICATE_FILES, [replicate(2, 2, wrong)])).problems).toEqual(['recipe 0 (replicate): copy 2 metadata SHA-256 differs from its pin']);
  });

  it('composes pad into replicate, reading the earlier output', async () => {
    const big = padded('é', 1000);
    const outputs = pinsFor(metaTemplate(), 2, 2);
    const result = await expand({ ...REPLICATE_FILES, 'documents/t-pad.template.json': TEMPLATE }, [
      pad('é', Buffer.byteLength(big), audit(big), 'documents/t-pad.template.json', 'documents/t-big.v1.json'),
      replicate(2, 2, outputs, { payload: 'documents/t-big.v1.json' }),
    ]);
    expect(result.problems).toEqual([]);
    expect(Buffer.from(result.outputs.get('documents/t-copy-02.v1.json') ?? []).toString('utf8')).toBe(big);
  });
});

describe('recipe graph and resource bounds', () => {
  const files = { ...REPLICATE_FILES, 'documents/t-pad.template.json': TEMPLATE, 'documents/t-committed.v1.json': PAYLOAD };

  it('refuses forward and self references, unlisted inputs, collisions and duplicate outputs without reading', () => {
    const graph = (recipes: unknown[]) => checkRecipeGraph(manifestOf(files, recipes)).problems;
    expect(graph([replicate(1, 2, pinsFor(metaTemplate(), 1, 2), { payload: 'documents/t-big.v1.json' }), pad('a', 100, audit(''), 'documents/t-pad.template.json', 'documents/t-big.v1.json')])).toEqual([
      'recipe 0 (replicate): payload is a forward reference to the output of recipe 1',
    ]);
    expect(graph([pad('a', 100, audit(''), 'documents/t-big.v1.json', 'documents/t-big.v1.json')])).toEqual(['recipe 0 (pad): template is a forward reference to the output of recipe 0']);
    expect(graph([pad('a', 100, audit(''), 'documents/t-unlisted.template.json')])).toEqual(['recipe 0 (pad): template is neither a listed template nor an earlier recipe output']);
    expect(graph([pad('a', 100, audit(''), 'documents/t-committed.v1.json')])).toEqual(['recipe 0 (pad): template is neither a listed template nor an earlier recipe output']);
    expect(graph([pad('a', 100, audit(''), 'documents/t-pad.template.json', 'documents/t-committed.v1.json')])).toEqual([
      'recipe 0 (pad): output documents/t-committed.v1.json collides with a committed file',
    ]);
    expect(graph([pad('a', 100, audit('')), pad('b', 100, audit(''))])).toEqual(['recipe 1 (pad): output documents/t-pad.v1.json duplicates the output of recipe 0']);
    expect(graph([pad('a', 100, audit(''), 'documents/t-pad.template.json', 'documents/t-pad.meta.json')])).toEqual(['recipe 0 (pad): output slot t-pad.meta ends in .meta or .template (N3)']);
    const copy = pinsFor(metaTemplate(), 1, 2);
    expect(graph([replicate(1, 2, copy), replicate(1, 2, [{ slot: 't-copy-02.v1', metadataSha256: audit('') }], { payload: 'documents/t-copy-01.v1.meta.json' })])).toEqual([
      'recipe 1 (replicate): payload is generated metadata, not a payload',
    ]);
  });

  it('allows exactly 4,194,304 generated bytes per fixture and refuses one recipe above', async () => {
    const largest = padded('a', MAX_TARGET_BYTES - BASE);
    const two = [pad('a', MAX_TARGET_BYTES, audit(largest), 'documents/t-pad.template.json', 'documents/t-one.v1.json'), pad('a', MAX_TARGET_BYTES, audit(largest), 'documents/t-pad.template.json', 'documents/t-two.v1.json')];
    expect(2 * MAX_TARGET_BYTES).toBe(MAX_GENERATED_BYTES);
    expect((await expand(files, two)).problems).toEqual([]);
    const third = pad('a', BASE + 1, audit(padded('a', 1)), 'documents/t-pad.template.json', 'documents/t-three.v1.json');
    const over = await expand(files, [...two, third]);
    expect(over.problems).toEqual([`recipe 2 (pad): the fixture's recipes would generate more than ${MAX_GENERATED_BYTES} bytes`]);
    expect(over.outputs.has('documents/t-three.v1.json')).toBe(false);
  });

  it('counts every copy and its payload in the budget and refuses a huge width before rendering', async () => {
    const bigPayload = { ...REPLICATE_FILES, 'documents/t-copy.payload.template.json': 'x'.repeat(70_000) };
    const pins = Array.from({ length: 60 }, (_, index) => ({ slot: `t-copy-${index + 1}.v1`, metadataSha256: audit('') }));
    expect((await expand(bigPayload, [replicate(60, 1, pins)])).problems).toEqual([`recipe 0 (replicate): the fixture's recipes would generate more than ${MAX_GENERATED_BYTES} bytes`]);
    expect((await expand(REPLICATE_FILES, [replicate(1, 2 ** 40, [{ slot: 't-copy-1.v1', metadataSha256: audit('') }])])).problems).toEqual([
      `recipe 0 (replicate): the fixture's recipes would generate more than ${MAX_GENERATED_BYTES} bytes`,
    ]);
  });
});
