import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PolicyPackV2 } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixture.js';
import { CORE_BATCH } from './frozen-v2.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const read = (path: string) => readFile(join(REPO_ROOT, path));

describe('v2 core batch pins', () => {
  it('pins the exact bytes of the candidate v2 pack', async () => {
    const bytes = await read(CORE_BATCH.policyPack.path);
    expect(sha256(bytes)).toBe(CORE_BATCH.policyPack.sha256);
    expect(PolicyPackV2.parse(JSON.parse(bytes.toString('utf8'))).packId).toBe(CORE_BATCH.policyPack.packId);
  });

  it('pins the exact bytes of every negative policy input', async () => {
    for (const input of CORE_BATCH.policyInputs) {
      const bytes = await read(input.path);
      expect(sha256(bytes), input.path).toBe(input.sha256);
      expect(PolicyPackV2.parse(JSON.parse(bytes.toString('utf8'))).packId, input.path).toBe(input.packId);
      expect(input.path.startsWith(`${CORE_BATCH.root}/policy-inputs/`), input.path).toBe(true);
    }
  });

  it('derives the F15 unreviewed input from the pack by changing only packId and reviewedAsOf', async () => {
    const pack = (await read(CORE_BATCH.policyPack.path)).toString('utf8');
    const [input] = CORE_BATCH.policyInputs;
    const derived = pack
      .replace('"packId": "lab-k0823-jd-20261018-v2",', '"packId": "lab-k0823-jd-20261018-v2-unreviewed",')
      .replace('"reviewedAsOf": "2026-10-18",', '"reviewedAsOf": null,');
    expect(derived).not.toBe(pack);
    expect((await read(input.path)).toString('utf8')).toBe(derived);
    expect(PolicyPackV2.parse(JSON.parse(derived)).reviewedAsOf).toBeNull();
  });

  it('pins no fixture yet', () => {
    expect(Object.keys(CORE_BATCH.fixtures)).toEqual([]);
  });
});
