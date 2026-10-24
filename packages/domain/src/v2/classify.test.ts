import { type DocumentRef, EvidenceFactV2 } from '@pa/contracts';
import { describe, expect, it, vi } from 'vitest';

import {
  bytesOf,
  caseV2,
  documentV2,
  encounterBody,
  inputV2,
  noteBody,
  orderBody,
  permute,
  receiptBody,
  SUBJECT_ID,
  SUBJECT_NAME,
  supplierBody,
  supportedDocumentsV2,
} from '../../test/builders-v2.js';
import { webCryptoSha256 } from '../hash.js';
import { type VersionClass } from './classify.js';
import { type AssessmentInputV2 } from './input.js';
import { preflightV2, type PreflightOptions, type PreflightSnapshot } from './preflight.js';

const ref = (documentId: string, version = 1): DocumentRef => ({ documentId, version });
const encoder = new TextEncoder();

async function snapshotOf(input: AssessmentInputV2, options: PreflightOptions = {}): Promise<PreflightSnapshot> {
  const result = await preflightV2(input, options);
  if (result.outcome !== 'preflighted') {
    throw new Error(`expected a preflighted snapshot, got ${JSON.stringify(result.rejection)}`);
  }
  return result.snapshot;
}

function classOf(snapshot: PreflightSnapshot, documentId: string, version = 1): VersionClass {
  const found = snapshot.versions.find((candidate) => candidate.ref.documentId === documentId && candidate.ref.version === version);
  if (found === undefined) {
    throw new Error(`${documentId} v${version} not classified`);
  }
  return found.classification;
}

const statusOf = (snapshot: PreflightSnapshot, documentId: string, version = 1) => {
  const classification = classOf(snapshot, documentId, version);
  return classification.status === 'r09' ? classification.conditionKey : classification.status === 'quarantined' ? classification.bases : 'usable';
};

const valuesOf = (snapshot: PreflightSnapshot, documentId: string, version = 1) => {
  const classification = classOf(snapshot, documentId, version);
  if (classification.status !== 'usable' || classification.content === null) {
    throw new Error(`${documentId} v${version} has no content`);
  }
  return new Map(classification.content.values.map((value) => [value.field, value]));
};

describe('R09 first applicable condition (C09)', () => {
  it('classifies the supported packet as usable and current', async () => {
    const snapshot = await snapshotOf(inputV2(await supportedDocumentsV2()));
    expect(snapshot.versions.map((version) => [version.ref.documentId, version.current, version.classification.status])).toEqual([
      ['encounter', true, 'usable'],
      ['order', true, 'usable'],
      ['receipt', true, 'usable'],
      ['supplier-status', true, 'usable'],
    ]);
    expect(snapshot.quarantinedDocuments).toEqual([]);
    expect(snapshot.supersededDocuments).toEqual([]);
  });

  it('applies restriction, hash, declared unreadability, MIME, body and kind in that order', async () => {
    const wrongBytes = bytesOf(noteBody({ title: 'Different bytes' }));
    const documents = [
      await documentV2('restricted.v1', 'restricted', noteBody(), { meta: { accessStatus: 'restricted' } }),
      // A hash mismatch wins over declared unreadability, an unsupported MIME type and a kind mismatch.
      await documentV2('hash.v1', 'hash', noteBody(), { meta: { accessStatus: 'unreadable', mimeType: 'text/plain', kind: 'order' }, payload: wrongBytes }),
      // Declared unreadability is not rescued by valid, hash-matching bytes.
      await documentV2('unreadable.v1', 'unreadable', encounterBody(), { meta: { accessStatus: 'unreadable', mimeType: 'text/plain' } }),
      await documentV2('mime.v1', 'mime', encoder.encode('not json'), { meta: { mimeType: 'text/plain' } }),
      await documentV2('body.v1', 'body', encoder.encode('{"schemaVersion": "pa.source.supporting-note.v1"'), { meta: { kind: 'order' } }),
      await documentV2('utf8.v1', 'utf8', new Uint8Array([0x7b, 0xff, 0x7d])),
      await documentV2('kind.v1', 'kind', noteBody(), { meta: { kind: 'encounter' } }),
    ];
    const snapshot = await snapshotOf(inputV2(documents));
    expect(Object.fromEntries(snapshot.versions.map((version) => [version.ref.documentId, statusOf(snapshot, version.ref.documentId)]))).toEqual({
      body: 'R09.body_invalid',
      hash: 'R09.hash_mismatch',
      kind: 'R09.kind_mismatch',
      mime: 'R09.mime_unsupported',
      restricted: 'R09.access_restricted',
      unreadable: 'R09.access_unreadable',
      utf8: 'R09.body_invalid',
    });
    for (const version of snapshot.versions) {
      expect(version.classification).not.toHaveProperty('content');
    }
  });

  it('hashes the exact bytes before reading them and never hashes a restricted or metadata-quarantined version', async () => {
    const sha256 = vi.fn(webCryptoSha256);
    const documents = [
      await documentV2('restricted.v1', 'restricted', noteBody(), { meta: { accessStatus: 'restricted' } }),
      await documentV2('other.v1', 'other', noteBody(), { meta: { subjectId: 'SYN-OTHER' } }),
      await documentV2('note.v1', 'note', noteBody()),
    ];
    await snapshotOf(inputV2(documents), { sha256 });
    expect(sha256).toHaveBeenCalledTimes(1);
    expect(sha256).toHaveBeenCalledWith(documents[2]?.payload);
  });

  it('rejects a blank title as an invalid body but accepts blank narrative and note text (D1)', async () => {
    const snapshot = await snapshotOf(
      inputV2([
        await documentV2('title.v1', 'title', noteBody({ title: '   ' })),
        await documentV2('text.v1', 'text', noteBody({ text: '' })),
        await documentV2('spaces.v1', 'spaces', noteBody({ text: '  \t ' })),
        await documentV2('encounter.v1', 'encounter', encounterBody({ narrative: '' })),
      ]),
    );
    expect([statusOf(snapshot, 'title'), statusOf(snapshot, 'text'), statusOf(snapshot, 'spaces'), statusOf(snapshot, 'encounter')]).toEqual([
      'R09.body_invalid',
      'usable',
      'usable',
      'usable',
    ]);
  });
});

describe('R02 binding (D1, C09)', () => {
  it('quarantines on metadata subject alone, whatever the provenance, without reading the body', async () => {
    const documents = [
      await documentV2('restricted.v1', 'restricted', noteBody(), { meta: { accessStatus: 'restricted', subjectId: 'SYN-OTHER' } }),
      await documentV2('hash.v1', 'hash', noteBody(), { meta: { subjectId: 'SYN-OTHER' }, payload: encoder.encode('{}') }),
      await documentV2('named.v1', 'named', noteBody({ beneficiary: { name: 'Someone Else', identifier: 'SYN-ELSE' } }), { meta: { subjectId: 'SYN-OTHER' } }),
    ];
    const snapshot = await snapshotOf(inputV2(documents));
    for (const documentId of ['restricted', 'hash', 'named']) {
      expect(classOf(snapshot, documentId)).toEqual({ status: 'quarantined', bases: ['binding.metadata_subject'] });
    }
    expect(snapshot.quarantinedDocuments).toEqual([ref('hash'), ref('named'), ref('restricted')]);
  });

  it('compares each stated identifier and name literally; either alternative alone may bind', async () => {
    const as = (name: string | null, identifier: string | null) => noteBody({ beneficiary: { name, identifier } });
    const snapshot = await snapshotOf(
      inputV2([
        await documentV2('both.v1', 'both', as(SUBJECT_NAME, SUBJECT_ID)),
        await documentV2('name-only.v1', 'name-only', as(SUBJECT_NAME, null)),
        await documentV2('id-only.v1', 'id-only', as(null, SUBJECT_ID)),
        await documentV2('neither.v1', 'neither', as(null, null)),
        await documentV2('padded.v1', 'padded', as(` ${SUBJECT_NAME}`, SUBJECT_ID)),
        await documentV2('case.v1', 'case', as(SUBJECT_NAME.toUpperCase(), SUBJECT_ID)),
        await documentV2('wrong-id.v1', 'wrong-id', as(SUBJECT_NAME, 'SYN-ELSE')),
        await documentV2('wrong-both.v1', 'wrong-both', as('Someone Else', 'SYN-ELSE')),
        await documentV2('receipt.v1', 'receipt', receiptBody({ beneficiary: { name: SUBJECT_NAME, identifier: 'SYN-ELSE' } })),
        await documentV2('supplier.v1', 'supplier', supplierBody({ supplierId: 'SYN-SUP-9999' })),
      ]),
    );
    expect(Object.fromEntries(snapshot.versions.map((version) => [version.ref.documentId, statusOf(snapshot, version.ref.documentId)]))).toEqual({
      both: 'usable',
      case: ['binding.stated_name'],
      'id-only': 'usable',
      'name-only': 'usable',
      neither: 'usable',
      padded: ['binding.stated_name'],
      receipt: ['binding.stated_identifier'],
      supplier: 'usable',
      'wrong-both': ['binding.stated_identifier', 'binding.stated_name'],
      'wrong-id': ['binding.stated_identifier'],
    });
  });

  it('lets quarantined and unusable versions carry no content', async () => {
    const snapshot = await snapshotOf(
      inputV2([
        await documentV2('padded.v1', 'padded', orderBody({ beneficiary: { name: ` ${SUBJECT_NAME}`, identifier: SUBJECT_ID } })),
        await documentV2('kind.v1', 'kind', noteBody(), { meta: { kind: 'encounter' } }),
      ]),
    );
    expect(classOf(snapshot, 'padded')).toEqual({ status: 'quarantined', bases: ['binding.stated_name'] });
    expect(classOf(snapshot, 'kind')).toEqual({ status: 'r09', conditionKey: 'R09.kind_mismatch' });
    expect(JSON.stringify(snapshot.versions.map((version) => version.classification))).not.toContain('Casey');
  });
});

describe('exact extraction (D1)', () => {
  it('keeps padded text, signer whitespace and number tokens exactly as written', async () => {
    const body = orderBody({
      item: { description: '  Power wheelchair, standard base  ', code: 'K0823', quantity: 1 },
      signature: { signerName: 'Casey Example, MD (synthetic) ', signedDate: '2026-09-02' },
    });
    const text = JSON.stringify(body, null, 2).replace('"quantity": 1', '"quantity": 1.0');
    expect(text).toContain('"quantity": 1.0');
    const snapshot = await snapshotOf(inputV2([await documentV2('order.v1', 'order', encoder.encode(text), { meta: { kind: 'order' } })]));
    const values = valuesOf(snapshot, 'order');
    expect(values.get('order.item_description')).toEqual({ field: 'order.item_description', locator: '/item/description', value: '  Power wheelchair, standard base  ', originalText: '  Power wheelchair, standard base  ' });
    expect(values.get('order.quantity')).toEqual({ field: 'order.quantity', locator: '/item/quantity', value: 1, originalText: '1.0' });
    expect(values.get('order.signature_signer_name')?.originalText).toBe('Casey Example, MD (synthetic) ');
    expect(values.has('order.timestamp')).toBe(false);
    for (const value of values.values()) {
      const fact = { schemaVersion: 'pa.evidence-fact.v2', factId: 'fact-1', documentId: 'order', documentVersion: 1, extractionMethod: 'deterministic', confidence: null, reviewStatus: 'proposed', ...value };
      expect(EvidenceFactV2.safeParse(fact).success, value.field).toBe(true);
    }
  });

  it('states every non-null value of each kind and skips null or absent ones', async () => {
    const snapshot = await snapshotOf(
      inputV2([
        await documentV2('encounter.v1', 'encounter', encounterBody({ completionTime: { timestamp: '2026-08-20T10:15:00-07:00', timeZone: 'America/Los_Angeles' } })),
        await documentV2('receipt.v1', 'receipt', receiptBody()),
        await documentV2('supplier.v1', 'supplier', supplierBody({ effectiveTo: null })),
      ]),
    );
    expect([...valuesOf(snapshot, 'encounter').keys()]).toContain('encounter.completion_timestamp');
    expect(valuesOf(snapshot, 'encounter').get('clinical.lower_level_devices')).toBeUndefined();
    expect(valuesOf(snapshot, 'receipt').get('receipt.order_document_version')).toMatchObject({ value: 1, originalText: '1' });
    expect(valuesOf(snapshot, 'supplier').get('supplier.established')).toMatchObject({ value: true, originalText: 'true' });
    expect(valuesOf(snapshot, 'supplier').has('supplier.effective_to')).toBe(false);
  });
});

describe('versions and lineage (D3, D5, C08)', () => {
  it('quarantines by exact version in both directions, leaving the other version usable', async () => {
    const bad = orderBody({ beneficiary: { name: 'Someone Else', identifier: SUBJECT_ID } });
    const older = await snapshotOf(inputV2([await documentV2('order.v1', 'order', bad), await documentV2('order.v2', 'order', orderBody(), { version: 2 })]));
    expect(older.quarantinedDocuments).toEqual([ref('order')]);
    expect(statusOf(older, 'order', 2)).toBe('usable');
    const newer = await snapshotOf(inputV2([await documentV2('order.v1', 'order', orderBody()), await documentV2('order.v2', 'order', bad, { version: 2 })]));
    expect(newer.quarantinedDocuments).toEqual([ref('order', 2)]);
    expect(statusOf(newer, 'order', 1)).toBe('usable');
  });

  it('lists a superseded target even when it is quarantined, and withholds content from a superseded usable version', async () => {
    const quarantinedTarget = await snapshotOf(
      inputV2([
        await documentV2('order.v1', 'order', orderBody({ beneficiary: { name: 'Someone Else', identifier: SUBJECT_ID } })),
        await documentV2('order.v2', 'order', orderBody(), { version: 2, meta: { supersedes: ref('order') } }),
      ]),
    );
    expect(quarantinedTarget.supersededDocuments).toEqual([ref('order')]);
    expect(quarantinedTarget.quarantinedDocuments).toEqual([ref('order')]);
    const usableTarget = await snapshotOf(
      inputV2([await documentV2('order.v1', 'order', orderBody()), await documentV2('order.v2', 'order', orderBody(), { version: 2, meta: { supersedes: ref('order') } })]),
    );
    expect(classOf(usableTarget, 'order', 1)).toEqual({ status: 'usable', content: null });
    expect(usableTarget.versions.map((version) => version.current)).toEqual([false, true]);
  });

  it('never reactivates older evidence when the superseder is restricted, unreadable, failed or quarantined', async () => {
    const superseders = [
      { meta: { accessStatus: 'restricted' as const } },
      { meta: { accessStatus: 'unreadable' as const } },
      { payload: encoder.encode('{}') },
      { body: orderBody({ beneficiary: { name: 'Someone Else', identifier: SUBJECT_ID } }) },
    ];
    for (const { body, ...options } of superseders) {
      const snapshot = await snapshotOf(
        inputV2([
          await documentV2('order.v1', 'order', orderBody()),
          await documentV2('order.v2', 'order', body ?? orderBody(), { version: 2, ...options, meta: { ...options.meta, supersedes: ref('order') } }),
        ]),
      );
      expect(snapshot.supersededDocuments).toEqual([ref('order')]);
      expect(classOf(snapshot, 'order', 1)).toEqual({ status: 'usable', content: null });
      expect(classOf(snapshot, 'order', 2).status).not.toBe('usable');
    }
  });

  it('still classifies a superseded restricted version through R09, a recorded limitation', async () => {
    const snapshot = await snapshotOf(
      inputV2([
        await documentV2('encounter.v1', 'encounter', encounterBody(), { meta: { accessStatus: 'restricted' } }),
        await documentV2('encounter.v2', 'encounter', encounterBody(), { version: 2, meta: { supersedes: ref('encounter') } }),
      ]),
    );
    expect(statusOf(snapshot, 'encounter', 1)).toBe('R09.access_restricted');
    expect(snapshot.supersededDocuments).toEqual([ref('encounter')]);
    expect(statusOf(snapshot, 'encounter', 2)).toBe('usable');
  });

  it('gives the same canonical snapshot under reversed and permuted input with slot labels kept', async () => {
    const documents = [
      ...(await supportedDocumentsV2()),
      await documentV2('order.v2', 'order', orderBody({ beneficiary: { name: 'Someone Else', identifier: SUBJECT_ID } }), { version: 2, meta: { supersedes: ref('order') } }),
      await documentV2('order.v3', 'order', orderBody(), { version: 3, meta: { supersedes: ref('order', 2) } }),
      await documentV2('note.v1', 'note', noteBody(), { meta: { accessStatus: 'restricted' } }),
      await documentV2('note.v2', 'note', noteBody(), { version: 2, meta: { supersedes: ref('note') } }),
      await documentV2('other.v1', 'other', noteBody(), { meta: { subjectId: 'SYN-OTHER' } }),
      await documentV2('late.v4', 'late', noteBody(), { version: 4, meta: { supersedes: ref('late', 3) } }),
    ];
    const expected = await snapshotOf(inputV2(documents));
    expect(expected.supersededDocuments).toEqual([ref('note'), ref('order'), ref('order', 2)]);
    expect(expected.quarantinedDocuments).toEqual([ref('order', 2), ref('other')]);
    for (const ordering of [[...documents].reverse(), permute(documents)]) {
      expect(await snapshotOf(inputV2(ordering))).toEqual(expected);
    }
  });

  it('works with an exact case that names a different subject only by spelling', async () => {
    const caseRecord = caseV2({ subjectName: 'Riley  Testcase' });
    const snapshot = await snapshotOf(inputV2(await supportedDocumentsV2(), { caseRecord }));
    expect(snapshot.quarantinedDocuments).toEqual([ref('encounter'), ref('order'), ref('receipt')]);
  });
});
