import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { PolicyPackV2 } from '@pa/contracts';
import { checkPolicyPackV2, EVALUATOR_INVENTORY_V2, packCoverageGaps } from '@pa/domain';
import { beforeAll, describe, expect, it } from 'vitest';

import { REPO_ROOT } from './fixture.js';
import { CORE_BATCH } from './frozen-v2.js';

// Pinned-pack coverage (D6 clarification): the reviewed v2 pack, read
// at the path the unchanged core table pins and verified against its SHA-256,
// covers the v2 evaluator inventory, so none of the frozen expectations meets
// the coverage rejection. The domain receives only bytes or a parsed value.

const encoder = new TextEncoder();
let bytes: Uint8Array;

beforeAll(async () => {
  bytes = new Uint8Array(await readFile(join(REPO_ROOT, CORE_BATCH.policyPack.path)));
});

const parsedPack = () => PolicyPackV2.parse(JSON.parse(new TextDecoder().decode(bytes)));

describe('reviewed v2 pack coverage', () => {
  it('reads the bytes pinned by the core table', () => {
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(CORE_BATCH.policyPack.sha256);
    expect(parsedPack().packId).toBe(CORE_BATCH.policyPack.packId);
  });

  it('covers every status and condition the evaluator supports', () => {
    expect(packCoverageGaps(parsedPack())).toEqual([]);
    expect(checkPolicyPackV2(bytes)).toEqual({ pack: parsedPack() });
  });

  it('allows declared keys the evaluator cannot emit yet, including R09.locator_unresolved', () => {
    const declared = parsedPack().rules.flatMap((rule) => rule.outcomes.flatMap((outcome) => outcome.conditions.map((condition) => condition.conditionKey)));
    const supported = Object.values(EVALUATOR_INVENTORY_V2).flatMap((rule) => rule.conditions.map((condition) => condition.conditionKey));
    expect(declared.filter((key) => !supported.includes(key))).toEqual(['R09.locator_unresolved']);
    expect(supported.filter((key) => !declared.includes(key))).toEqual([]);
  });

  it('accepts the pinned unreviewed negative input, which only R08 judges', async () => {
    const [input] = CORE_BATCH.policyInputs;
    const negative = new Uint8Array(await readFile(join(REPO_ROOT, input.path)));
    expect(createHash('sha256').update(negative).digest('hex')).toBe(input.sha256);
    const checked = checkPolicyPackV2(negative);
    expect('pack' in checked && checked.pack.packId).toBe(input.packId);
    expect('pack' in checked && packCoverageGaps(checked.pack)).toEqual([]);
  });

  it('rejects an in-memory copy without one supported key, so the check is not vacuous', () => {
    const pack = parsedPack();
    for (const outcome of pack.rules.find((rule) => rule.ruleId === 'R03')?.outcomes ?? []) {
      outcome.conditions = outcome.conditions.filter((condition) => condition.conditionKey !== 'R03.element_missing');
    }
    expect(PolicyPackV2.safeParse(pack).success).toBe(true);
    expect(checkPolicyPackV2(encoder.encode(JSON.stringify(pack)))).toEqual({ reason: { code: 'policy_pack_invalid', documentRef: null, path: '/policyPack' } });
  });
});
