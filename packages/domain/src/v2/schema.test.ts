import { CaseV2, type DocumentRef, PolicyPackV2, type RejectionCode, type RejectionReason, type RejectionStage } from '@pa/contracts';
import { describe, expect, it, vi } from 'vitest';

import { testPack } from '../../test/builders.js';
import {
  bytesOf,
  caseV2,
  documentV2,
  editRule,
  inputV2,
  noteBody,
  orderBody,
  packV2,
  permute,
  SUBJECT_NAME,
  supportedDocumentsV2,
  withoutKey,
  withoutOutcome,
  withoutRule,
} from '../../test/builders-v2.js';
import { webCryptoSha256 } from '../hash.js';
import { type AssessmentInputV2 } from './input.js';
import { packCoverageGaps } from './inventory.js';
import { preflightV2, type PreflightStage } from './preflight.js';
import { checkPolicyPackV2 } from './schema.js';

const reason = (code: RejectionCode, documentRef: DocumentRef | null, path: string): RejectionReason => ({ code, documentRef, path });
const INVALID = reason('policy_pack_invalid', null, '/policyPack');
const INCOMPLETE = reason('policy_pack_incomplete', null, '/policyPack/rules');
const CASE_INVALID = reason('case_invalid', null, '/case');
const DATE_INVALID = reason('assessment_date_invalid', null, '/assessmentDate');
const DATE_MISMATCH = reason('assessment_date_mismatch', null, '/assessmentDate');

async function rejectionOf(input: AssessmentInputV2) {
  const result = await preflightV2(input);
  if (result.outcome !== 'rejected') {
    throw new Error('expected a rejection');
  }
  return result.rejection;
}

async function expectRejected(input: AssessmentInputV2, stage: RejectionStage, reasons: RejectionReason[]) {
  expect(await rejectionOf(input)).toEqual({ schemaVersion: 'pa.input-rejection.v1', stage, reasons });
}

/** Asserts a semantic test pack still passes the v2 schema, so the branch under test is not structural invalidity. */
function valid(pack: PolicyPackV2): PolicyPackV2 {
  expect(PolicyPackV2.safeParse(pack).success).toBe(true);
  return pack;
}

const packReason = (pack: unknown) => {
  const checked = checkPolicyPackV2(bytesOf(pack));
  return 'reason' in checked ? checked.reason : null;
};

describe('pack coverage (D6 clarification)', () => {
  it('accepts the complete test pack, which also declares the unemitted R09.locator_unresolved', () => {
    const pack = valid(packV2());
    expect(packCoverageGaps(pack)).toEqual([]);
    expect(packReason(pack)).toBeNull();
    expect(packReason(valid(withoutKey(pack, 'R09.locator_unresolved')))).toBeNull();
  });

  it('rejects a v1 pack as policy_pack_invalid', () => {
    expect(packReason(testPack())).toEqual(INVALID);
  });

  it('reports only policy_pack_invalid for a schema-invalid pack, even when a rule is also missing', () => {
    const pack = { ...withoutRule(packV2(), 'R03'), title: ' Padded title ' };
    expect(PolicyPackV2.safeParse(pack).success).toBe(false);
    expect(packReason(pack)).toEqual(INVALID);
    expect(packReason(bytesOf('not a pack'))).toEqual(INVALID);
    expect(checkPolicyPackV2(new Uint8Array([0xff, 0xfe]))).toEqual({ reason: INVALID });
  });

  it('reports only policy_pack_incomplete for a valid pack missing a rule, even when another rule omits a key', () => {
    expect(packReason(valid(withoutRule(packV2(), 'R05')))).toEqual(INCOMPLETE);
    expect(packReason(valid(withoutKey(withoutRule(packV2(), 'R05'), 'R03.element_missing')))).toEqual(INCOMPLETE);
    expect(packReason(valid(withoutOutcome(withoutRule(packV2(), 'R10'), 'R02', 'pass')))).toEqual(INCOMPLETE);
  });

  it('reports policy_pack_invalid for a valid complete pack missing one supported condition key', () => {
    const pack = valid(withoutKey(packV2(), 'R03.element_missing'));
    expect(packCoverageGaps(pack)).toEqual(['R03.element_missing: not declared under missing']);
    expect(packReason(pack)).toEqual(INVALID);
  });

  it('reports policy_pack_invalid for a missing supported non-pass outcome and for a missing supported pass outcome', () => {
    const noRestricted = valid(withoutOutcome(packV2(), 'R03', 'restricted'));
    expect(packCoverageGaps(noRestricted)).toEqual(['R03: no restricted outcome', 'R03.order_restricted: not declared under restricted']);
    expect(packReason(noRestricted)).toEqual(INVALID);
    const noPass = valid(withoutOutcome(packV2(), 'R02', 'pass'));
    expect(packCoverageGaps(noPass)).toEqual(['R02: no pass outcome']);
    expect(packReason(noPass)).toEqual(INVALID);
  });

  it('reports policy_pack_invalid for a key declared under another status', () => {
    const moved = valid(
      editRule(packV2(), 'R05', (rule) => {
        const [missing, unsequenced] = [rule.outcomes.find((o) => o.status === 'missing'), rule.outcomes.find((o) => o.status === 'manual_review')];
        const key = missing?.conditions.find((condition) => condition.conditionKey === 'R05.order_receipt_missing');
        if (missing === undefined || unsequenced === undefined || key === undefined) {
          throw new Error('test pack shape');
        }
        missing.conditions = missing.conditions.filter((condition) => condition !== key);
        unsequenced.conditions.push(key);
      }),
    );
    expect(packReason(moved)).toEqual(INVALID);
  });

  it('reports policy_pack_invalid when a kept key cannot represent its emitted qualifier, field or document shape', () => {
    const declaration = (pack: PolicyPackV2, key: string) => {
      const found = pack.rules.flatMap((rule) => rule.outcomes.flatMap((outcome) => outcome.conditions)).find((condition) => condition.conditionKey === key);
      if (found === undefined) {
        throw new Error(key);
      }
      return found;
    };
    const variants: [string, (pack: PolicyPackV2) => void][] = [
      ['qualifier', (pack) => Object.assign(declaration(pack, 'R03.element_missing'), { qualifier: 'none', fields: [] })],
      ['field value', (pack) => Object.assign(declaration(pack, 'R03.element_missing'), { fields: declaration(pack, 'R03.element_missing').fields.filter((field) => field !== 'element.signature') })],
      ['arity', (pack) => Object.assign(declaration(pack, 'R04.date_not_stated'), { documentArity: 'two' })],
      ['document kind', (pack) => Object.assign(declaration(pack, 'R09.hash_mismatch'), { documentKinds: ['order', 'encounter', 'order_receipt', 'supporting_note'] })],
      ['binding kind', (pack) => Object.assign(declaration(pack, 'R02.document_quarantined'), { documentKinds: ['order', 'encounter', 'order_receipt'] })],
    ];
    for (const [label, mutate] of variants) {
      const pack = structuredClone(packV2());
      mutate(pack);
      valid(pack);
      expect(packReason(pack), label).toEqual(INVALID);
    }
  });

  it('reports policy_pack_invalid when the pack changes routing the evaluator relies on', () => {
    const route = (ruleId: 'R06' | 'R10', change: object) =>
      valid(
        editRule(packV2(), ruleId, (rule) => {
          Object.assign(rule.outcomes[0] ?? {}, change);
        }),
      );
    expect(packReason(route('R06', { responsibleRole: 'administrative_reviewer' }))).toEqual(INVALID);
    expect(packReason(route('R06', { stateEffect: 'needs_human_review' }))).toEqual(INVALID);
    expect(packReason(route('R10', { stateEffect: 'needs_information' }))).toEqual(INVALID);
    // Routing the evaluator does not rely on stays the pack's choice.
    expect(packReason(route('R10', { responsibleRole: 'authorization_coordinator' }))).toBeNull();
  });

  it('returns one pack reason for many missing keys and outcomes', async () => {
    const pack = valid(withoutOutcome(withoutKey(withoutKey(packV2(), 'R03.element_missing'), 'R04.order_after_bound'), 'R07', 'pass'));
    expect(packCoverageGaps(pack).length).toBe(3);
    await expectRejected(inputV2(await supportedDocumentsV2(), { pack }), 'schema', [INVALID]);
  });
});

describe('schema rejection combinations (D6)', () => {
  const PACK_DEFECTS: [string, unknown, RejectionReason][] = [
    ['schema-invalid pack', testPack(), INVALID],
    ['pack missing a rule', withoutRule(packV2(), 'R08'), INCOMPLETE],
    ['pack missing a supported key', withoutKey(packV2(), 'R05.no_usable_receipt'), INVALID],
  ];

  it.each(PACK_DEFECTS)('%s with an invalid case gives both reasons in canonical order', async (_label, pack, packDefect) => {
    const caseRecord = caseV2({ subjectName: ` ${SUBJECT_NAME}` });
    await expectRejected(inputV2(await supportedDocumentsV2(), { caseRecord, pack }), 'schema', [CASE_INVALID, packDefect]);
  });

  it.each(PACK_DEFECTS)('%s with an invalid case, two invalid sidecars and an invalid argument gives the complete reason set', async (_label, pack, packDefect) => {
    const named = await documentV2('ord-b.v1', 'ord-b', noteBody(), { metadataBytes: bytesOf({ documentId: 'ord-b', version: 1, kind: 'unknown_kind' }) });
    const anonymous = await documentV2('ord-a.v1', 'ord-a', noteBody(), { metadataBytes: bytesOf({ documentId: 'bad id with spaces', version: 1 }) });
    const caseRecord = { ...caseV2(), assessmentDate: '2026-10-19', subjectName: '' };
    const input = inputV2([...(await supportedDocumentsV2()), named, anonymous], { caseRecord, pack, assessmentDate: '2026-02-30' });
    await expectRejected(input, 'schema', [
      DATE_INVALID,
      CASE_INVALID,
      reason('document_metadata_invalid', null, '/documents/ord-a.v1/metadata'),
      reason('document_metadata_invalid', { documentId: 'ord-b', version: 1 }, '/documents/ord-b.v1/metadata'),
      packDefect,
    ]);
  });

  it.each(PACK_DEFECTS)('%s with valid differing dates and invalid metadata gives the mismatch, every metadata reason and the pack reason', async (_label, pack, packDefect) => {
    const first = await documentV2('note-1.v1', 'note-1', noteBody(), { metadataBytes: bytesOf('metadata') });
    const second = await documentV2('note-2.v3', 'note-2', noteBody(), { metadataBytes: bytesOf({ documentId: 'note-2', version: 3, supersedes: { documentId: 'note-2', version: 3 } }) });
    const input = inputV2([second, ...(await supportedDocumentsV2()), first], { pack, assessmentDate: '2026-10-19' });
    await expectRejected(input, 'schema', [
      DATE_MISMATCH,
      reason('document_metadata_invalid', null, '/documents/note-1.v1/metadata'),
      reason('document_metadata_invalid', { documentId: 'note-2', version: 3 }, '/documents/note-2.v3/metadata'),
      packDefect,
    ]);
    // An invalid case suppresses the mismatch even though its written date differs from the valid argument.
    const invalidCase = { ...caseV2(), assessmentDate: '2026-10-19', synthetic: false };
    await expectRejected(inputV2(await supportedDocumentsV2(), { caseRecord: invalidCase, pack, assessmentDate: '2026-10-18' }), 'schema', [CASE_INVALID, packDefect]);
  });

  it('reports the same canonical schema reasons for reversed and permuted documents', async () => {
    const sidecars = await Promise.all(
      ['m-10', 'm-9', 'M-1', 'm-1'].map((documentId, index) =>
        documentV2(`${documentId}.v1`, documentId, noteBody(), { metadataBytes: bytesOf(index % 2 === 0 ? { documentId, version: 1 } : 'invalid') }),
      ),
    );
    const documents = [...(await supportedDocumentsV2()), ...sidecars];
    const expected = await rejectionOf(inputV2(documents));
    expect(expected.reasons.map((entry) => entry.path)).toEqual(['/documents/m-1.v1/metadata', '/documents/m-9.v1/metadata', '/documents/M-1.v1/metadata', '/documents/m-10.v1/metadata']);
    for (const ordering of [[...documents].reverse(), permute(documents)]) {
      expect(await rejectionOf(inputV2(ordering))).toEqual(expected);
    }
  });

  it('judges a mismatch only when both the case and the argument are valid', async () => {
    const documents = await supportedDocumentsV2();
    const invalidCase = { ...caseV2(), assessmentDate: '2026-10-19', revision: 0 };
    await expectRejected(inputV2(documents, { caseRecord: invalidCase, assessmentDate: '2026-10-18' }), 'schema', [CASE_INVALID]);
    await expectRejected(inputV2(documents, { assessmentDate: '18 October 2026' }), 'schema', [DATE_INVALID]);
    await expectRejected(inputV2(documents, { assessmentDate: '2026-10-17' }), 'schema', [DATE_MISMATCH]);
    expect((await preflightV2(inputV2(documents))).outcome).toBe('preflighted');
  });

  it('stops at the schema stage with a pack coverage defect beside an integrity defect: no snapshot processing or evaluation', async () => {
    const documents = await supportedDocumentsV2();
    const duplicate = { ...(await documentV2('order.v1', 'order', orderBody())), slot: 'order.v1.dup1' };
    const stages: PreflightStage[] = [];
    const sha256 = vi.fn(webCryptoSha256);
    const input = inputV2([...documents, duplicate], { pack: withoutKey(packV2(), 'R04.order_not_final') });
    const result = await preflightV2(input, { sha256, trace: (stage) => stages.push(stage) });
    expect(result).toEqual({ schemaVersion: 'pa.assessment-outcome.v3', outcome: 'rejected', rejection: { schemaVersion: 'pa.input-rejection.v1', stage: 'schema', reasons: [INVALID] } });
    expect(stages).toEqual(['schema']);
    expect(sha256).not.toHaveBeenCalled();
    // The same duplicate with a covering pack is an integrity rejection.
    expect((await rejectionOf(inputV2([...documents, duplicate]))).stage).toBe('snapshot_integrity');
  });
});

describe('case, metadata and argument parsing (D1, D6)', () => {
  it('rejects a padded or blank case name without transforming it, and accepts a case serialized after exact parsing', async () => {
    const documents = await supportedDocumentsV2();
    for (const subjectName of [` ${SUBJECT_NAME}`, `${SUBJECT_NAME}\t`, '   ', '']) {
      await expectRejected(inputV2(documents, { caseRecord: caseV2({ subjectName }) }), 'schema', [CASE_INVALID]);
    }
    const reparsed = CaseV2.parse(JSON.parse(JSON.stringify(caseV2())));
    expect(reparsed.subjectName).toBe(SUBJECT_NAME);
    const result = await preflightV2(inputV2(documents, { caseBytes: bytesOf(reparsed) }));
    expect(result.outcome === 'preflighted' && result.snapshot.caseRecord).toEqual(caseV2());
  });

  it('rejects case bytes that are not one valid UTF-8 JSON pa.case.v2', async () => {
    const documents = await supportedDocumentsV2();
    for (const caseBytes of [new Uint8Array([0xc3, 0x28]), new TextEncoder().encode('{"schemaVersion":'), bytesOf({ ...caseV2(), schemaVersion: 'pa.case.v1' }), bytesOf({ ...caseV2(), extra: true })]) {
      await expectRejected(inputV2(documents, { caseBytes }), 'schema', [CASE_INVALID]);
    }
  });

  it('names a metadata sidecar by reference only when both documentId and version parse', async () => {
    const meta = (slot: string, metadataBytes: Uint8Array) => documentV2(slot, 'unused', noteBody(), { metadataBytes });
    const documents = [
      await meta('m1', bytesOf({ documentId: 'doc-1', version: 2, kind: 'note' })),
      await meta('m2', bytesOf({ documentId: 'doc 2', version: 2 })),
      await meta('m3', bytesOf({ documentId: 'doc-3', version: 0 })),
      await meta('m4', bytesOf({ documentId: 'doc-4', version: 1.5 })),
      await meta('m5', bytesOf([{ documentId: 'doc-5', version: 1 }])),
      await meta('m6', new Uint8Array([0xff])),
      await meta('m7', bytesOf({ documentId: 'doc-7', version: 1 })),
    ];
    await expectRejected(inputV2(documents), 'schema', [
      reason('document_metadata_invalid', null, '/documents/m2/metadata'),
      reason('document_metadata_invalid', null, '/documents/m3/metadata'),
      reason('document_metadata_invalid', null, '/documents/m4/metadata'),
      reason('document_metadata_invalid', null, '/documents/m5/metadata'),
      reason('document_metadata_invalid', null, '/documents/m6/metadata'),
      reason('document_metadata_invalid', { documentId: 'doc-1', version: 2 }, '/documents/m1/metadata'),
      reason('document_metadata_invalid', { documentId: 'doc-7', version: 1 }, '/documents/m7/metadata'),
    ]);
  });

  it('rejects an equal or later same-ID supersession as invalid metadata, so no cycle reaches the graph', async () => {
    const selfReference = await documentV2('order.v1', 'order', noteBody(), { meta: { supersedes: { documentId: 'order', version: 1 } } });
    await expectRejected(inputV2([selfReference]), 'schema', [reason('document_metadata_invalid', { documentId: 'order', version: 1 }, '/documents/order.v1/metadata')]);
    // The cycle-shaped pair: v1 names v2 (invalid) and v2 names v1 (valid).
    const forward = await documentV2('order.v1', 'order', noteBody(), { meta: { supersedes: { documentId: 'order', version: 2 } } });
    const back = await documentV2('order.v2', 'order', noteBody(), { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } });
    await expectRejected(inputV2([back, forward]), 'schema', [reason('document_metadata_invalid', { documentId: 'order', version: 1 }, '/documents/order.v1/metadata')]);
  });

  it('never quotes a rejected value', async () => {
    const secret = 'Unique-Rejected-Value-7731';
    const documents = [await documentV2('n.v1', 'n', noteBody(), { metadataBytes: bytesOf({ documentId: 'n', version: 1, statement: secret }) })];
    const rejection = await rejectionOf(inputV2(documents, { caseRecord: caseV2({ subjectName: ` ${secret}` }), assessmentDate: secret }));
    expect(JSON.stringify(rejection)).not.toContain(secret);
    expect(JSON.stringify(rejection)).not.toContain('Unique');
  });

  it('does not reject a body that cannot be parsed: it is left to R09', async () => {
    const broken = await documentV2('note.v1', 'note', new TextEncoder().encode('{ not json'));
    const result = await preflightV2(inputV2([...(await supportedDocumentsV2()), broken]));
    expect(result.outcome).toBe('preflighted');
  });
});
