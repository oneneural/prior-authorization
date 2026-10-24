import { describe, expect, it } from 'vitest';

import { FIXTURE_IDS, loadFixture, validateSnapshot } from './fixtures.js';

describe('bounded runtime inputs', () => {
  it.each(FIXTURE_IDS)('loads original %s bytes without evaluator access', async (id) => {
    const snapshot = await loadFixture(id);
    expect(snapshot.documents.length).toBeGreaterThan(0);
    expect(validateSnapshot(snapshot)).toEqual(snapshot);
  });
  it('refuses unknown fixture paths', async () => {
    await expect(loadFixture('../F01' as 'F01')).rejects.toThrow('unknown fixture');
  });
  it('rejects count, unsafe slots, unsupported types and byte/hash violations', async () => {
    const snapshot = await loadFixture('F01');
    const doc = snapshot.documents[0]!;
    expect(() => validateSnapshot({ ...snapshot, documents: Array.from({ length: 51 }, () => doc) })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, documents: [{ ...doc, slot: '../escape' }] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, documents: [{ ...doc, metadataText: doc.metadataText.replace('application/json', 'text/html') }] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, documents: [{ ...doc, payload: 'x'.repeat(1_048_577) }] })).toThrow();
    expect(() => validateSnapshot({ ...snapshot, documents: [{ ...doc, payload: '{"changed":true}' }] })).toThrow();
  });
});
