import { ConditionDeclaration, RuleId } from '@pa/contracts';
import { describe, expect, it, vi } from 'vitest';

import { documentV2, inputV2, noteBody, packV2, SUBJECT_ID, supportedDocumentsV2 } from '../../test/builders-v2.js';
import { webCryptoSha256 } from '../hash.js';
import { assertAdapterContract, MAX_DOCUMENTS_V2, MAX_SOURCE_BYTES_V2 } from './input.js';
import { EVALUATOR_INVENTORY_V2, packCoverageGaps } from './inventory.js';
import { preflightV2 } from './preflight.js';

const encoder = new TextEncoder();

/** A supporting note whose UTF-8 payload is exactly `size` bytes, padded with a two-byte character where possible. */
function noteOfSize(size: number): Uint8Array {
  const empty = encoder.encode(JSON.stringify(noteBody({ text: '' })));
  const fill = size - empty.byteLength;
  return encoder.encode(JSON.stringify(noteBody({ text: 'é'.repeat(Math.floor(fill / 2)) + 'a'.repeat(fill % 2) })));
}

describe('adapter contract (D6 F26 conventions)', () => {
  it('accepts 50 supplied versions and refuses 51 before parsing anything', async () => {
    const body = noteBody();
    const notes = await Promise.all(Array.from({ length: MAX_DOCUMENTS_V2 }, (_, index) => documentV2(`note-${index}.v1`, `note-${index}`, body)));
    expect(notes).toHaveLength(50);
    expect((await preflightV2(inputV2(notes))).outcome).toBe('preflighted');

    const sha256 = vi.fn(webCryptoSha256);
    const extra = await documentV2('note-extra.v1', 'note-extra', body);
    await expect(preflightV2(inputV2([...notes, extra]), { sha256 })).rejects.toThrow(RangeError);
    expect(sha256).not.toHaveBeenCalled();
  });

  it('accepts a 1,048,576-byte payload and refuses 1,048,577 bytes, counting bytes rather than characters', async () => {
    const atLimit = noteOfSize(MAX_SOURCE_BYTES_V2);
    expect(atLimit.byteLength).toBe(1_048_576);
    expect(new TextDecoder().decode(atLimit).length).toBeLessThan(atLimit.byteLength);
    const result = await preflightV2(inputV2([await documentV2('note.v1', 'note', atLimit)]));
    expect(result.outcome === 'preflighted' && result.snapshot.versions[0]?.classification.status).toBe('usable');

    const overLimit = noteOfSize(MAX_SOURCE_BYTES_V2 + 1);
    expect(overLimit.byteLength).toBe(1_048_577);
    await expect(preflightV2(inputV2([await documentV2('note.v1', 'note', overLimit)]))).rejects.toThrow(RangeError);
  });

  it('has no aggregate byte limit', async () => {
    const big = noteOfSize(MAX_SOURCE_BYTES_V2);
    const documents = await Promise.all([1, 2, 3].map((index) => documentV2(`big-${index}.v1`, `big-${index}`, big)));
    expect(() => assertAdapterContract(inputV2(documents))).not.toThrow();
  });

  it('requires unique safe slot labels, which the loader guarantees', async () => {
    const [first] = await supportedDocumentsV2();
    if (first === undefined) {
      throw new Error('no document');
    }
    for (const slot of ['', '.hidden', 'a/b', 'a b', '../x', 'é']) {
      expect(() => assertAdapterContract(inputV2([{ ...first, slot }])), slot).toThrow(TypeError);
    }
    expect(() => assertAdapterContract(inputV2([first, { ...first }]))).toThrow(TypeError);
    expect(() => assertAdapterContract(inputV2([{ ...first, slot: 'Order_1.v1-x' }]))).not.toThrow();
  });

  it('keeps refusal messages content-free', async () => {
    const [first] = await supportedDocumentsV2();
    if (first === undefined) {
      throw new Error('no document');
    }
    expect(() => assertAdapterContract(inputV2([{ ...first, slot: SUBJECT_ID + '/x' }]))).toThrow(/^(?!.*SYN-BEN)/);
  });
});

describe('evaluator inventory', () => {
  it('is internally consistent and covered by the complete test pack', () => {
    const keys = new Set<string>();
    for (const ruleId of RuleId.options) {
      const { statuses, conditions } = EVALUATOR_INVENTORY_V2[ruleId];
      expect(new Set(statuses.map((entry) => entry.status)).size).toBe(statuses.length);
      for (const entry of conditions) {
        expect(entry.conditionKey.startsWith(`${ruleId}.`), entry.conditionKey).toBe(true);
        expect(statuses.some((status) => status.status === entry.status), entry.conditionKey).toBe(true);
        expect(keys.has(entry.conditionKey), entry.conditionKey).toBe(false);
        keys.add(entry.conditionKey);
        const { conditionKey, qualifier, documentArity } = entry;
        const declaration = { conditionKey, qualifier, fields: [...entry.fields], documentArity, documentKinds: [...entry.documentKinds], statement: 'Inventory entry.' };
        expect(ConditionDeclaration.safeParse(declaration).success, entry.conditionKey).toBe(true);
      }
      // Every non-pass status the evaluator selects owns at least one condition it emits.
      for (const { status } of statuses.filter((entry) => entry.status !== 'pass')) {
        expect(conditions.some((entry) => entry.status === status), `${ruleId} ${status}`).toBe(true);
      }
    }
    expect(keys.has('R09.locator_unresolved')).toBe(false);
    expect(keys.size).toBe(61);
    expect(packCoverageGaps(packV2())).toEqual([]);
  });
});
