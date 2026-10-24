import { type DocumentRef, type RejectionCode, type RejectionReason } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import { documentV2, encounterBody, inputV2, noteBody, orderBody, permute, supplierBody, supportedDocumentsV2 } from '../../test/builders-v2.js';
import { type AssessmentInputV2 } from './input.js';
import { preflightV2 } from './preflight.js';

const ref = (documentId: string, version = 1): DocumentRef => ({ documentId, version });
const reason = (code: RejectionCode, documentRef: DocumentRef, path: string): RejectionReason => ({ code, documentRef, path });

async function integrityReasons(input: AssessmentInputV2) {
  const result = await preflightV2(input);
  if (result.outcome !== 'rejected') {
    return [];
  }
  expect(result.rejection.stage).toBe('snapshot_integrity');
  return result.rejection.reasons;
}

async function superseded(input: AssessmentInputV2) {
  const result = await preflightV2(input);
  if (result.outcome !== 'preflighted') {
    throw new Error('expected a preflighted snapshot');
  }
  return result.snapshot.supersededDocuments;
}

const reorderings = <T>(values: readonly T[]) => [values, [...values].reverse(), permute(values)];

describe('snapshot integrity (D6)', () => {
  it('reports one duplicate reason for every slot that shares a reference', async () => {
    const order = await documentV2('order.v1', 'order', orderBody());
    const documents = [...(await supportedDocumentsV2()), { ...order, slot: 'order.v1.dup1' }, { ...order, slot: 'order.v1.dup2' }];
    expect(await integrityReasons(inputV2(documents))).toEqual([
      reason('duplicate_document_version', ref('order'), '/documents/order.v1.dup1/metadata'),
      reason('duplicate_document_version', ref('order'), '/documents/order.v1.dup2/metadata'),
      reason('duplicate_document_version', ref('order'), '/documents/order.v1/metadata'),
    ]);
  });

  it('checks payload presence against restriction for every slot', async () => {
    const restricted = await documentV2('note-r.v1', 'note-r', noteBody(), { meta: { accessStatus: 'restricted' }, payload: new Uint8Array([123, 125]) });
    const missing = await documentV2('note-m.v1', 'note-m', noteBody(), { payload: null });
    const unreadableMissing = await documentV2('note-u.v1', 'note-u', noteBody(), { meta: { accessStatus: 'unreadable' }, payload: null });
    expect(await integrityReasons(inputV2([unreadableMissing, restricted, missing]))).toEqual([
      reason('document_bytes_missing', ref('note-m'), '/documents/note-m.v1/payload'),
      reason('document_bytes_missing', ref('note-u'), '/documents/note-u.v1/payload'),
      reason('restricted_document_has_bytes', ref('note-r'), '/documents/note-r.v1/payload'),
    ]);
  });

  it('keeps byte checks but skips every supersession check when a duplicate holds', async () => {
    const order = await documentV2('order.v1', 'order', orderBody());
    const restricted = await documentV2('note-r.v1', 'note-r', noteBody(), { meta: { accessStatus: 'restricted' }, payload: new Uint8Array([1]) });
    const crossDocument = await documentV2('enc.v2', 'enc', encounterBody(), { version: 2, meta: { supersedes: ref('other') } });
    expect(await integrityReasons(inputV2([order, { ...order, slot: 'order.v1.dup1' }, restricted, crossDocument]))).toEqual([
      reason('duplicate_document_version', ref('order'), '/documents/order.v1.dup1/metadata'),
      reason('duplicate_document_version', ref('order'), '/documents/order.v1/metadata'),
      reason('restricted_document_has_bytes', ref('note-r'), '/documents/note-r.v1/payload'),
    ]);
  });

  it('rejects a reference to another document ID whether or not the target is supplied (cross-document reference decision, answer 4)', async () => {
    const supplier = await documentV2('supplier-status.v1', 'supplier-status', supplierBody());
    const alternate = await documentV2('supplier-alt.v1', 'supplier-alt', supplierBody(), { meta: { supersedes: ref('supplier-status') } });
    const expected = [reason('supersession_cross_document', ref('supplier-alt'), '/documents/supplier-alt.v1/metadata/supersedes')];
    expect(await integrityReasons(inputV2([supplier, alternate]))).toEqual(expected);
    // Absent target: still rejected, with no kind or subject comparison. No frozen oracle decides this combination.
    expect(await integrityReasons(inputV2([alternate]))).toEqual(expected);
    const absentOtherKind = await documentV2('note.v1', 'note', noteBody(), { meta: { supersedes: ref('missing-order', 4) } });
    expect(await integrityReasons(inputV2([absentOtherKind]))).toEqual([reason('supersession_cross_document', ref('note'), '/documents/note.v1/metadata/supersedes')]);
  });

  it('compares kind for a supplied target of a cross-document reference', async () => {
    const encounter = await documentV2('encounter.v1', 'encounter', encounterBody());
    const note = await documentV2('note.v2', 'note', noteBody(), { version: 2, meta: { supersedes: ref('encounter') } });
    const path = '/documents/note.v2/metadata/supersedes';
    expect(await integrityReasons(inputV2([encounter, note]))).toEqual([
      reason('supersession_cross_document', ref('note', 2), path),
      reason('supersession_cross_kind', ref('note', 2), path),
    ]);
  });

  it('compares kind and subject for a supplied target of a cross-document reference', async () => {
    const supplier = await documentV2('supplier-status.v1', 'supplier-status', supplierBody());
    const order = await documentV2('order.v2', 'order', orderBody(), { version: 2, meta: { supersedes: ref('supplier-status') } });
    const path = '/documents/order.v2/metadata/supersedes';
    expect(await integrityReasons(inputV2([supplier, order]))).toEqual([
      reason('supersession_cross_document', ref('order', 2), path),
      reason('supersession_cross_kind', ref('order', 2), path),
      reason('supersession_cross_subject', ref('order', 2), path),
    ]);
  });

  it('gives an absent earlier same-ID target no effect and no check', async () => {
    const order = await documentV2('order.v3', 'order', orderBody(), { version: 3, meta: { supersedes: ref('order', 2), subjectId: 'SYN-OTHER' } });
    const result = await preflightV2(inputV2([order]));
    expect(result.outcome).toBe('preflighted');
    expect(await superseded(inputV2([order, await documentV2('order.v1', 'order', orderBody())]))).toEqual([]);
  });

  it('rejects a supplied target of another kind', async () => {
    const old = await documentV2('record.v1', 'record', orderBody());
    const next = await documentV2('record.v2', 'record', noteBody(), { version: 2, meta: { supersedes: ref('record') } });
    expect(await integrityReasons(inputV2([old, next]))).toEqual([reason('supersession_cross_kind', ref('record', 2), '/documents/record.v2/metadata/supersedes')]);
  });

  it('rejects endpoints whose subjects differ from each other or from the case subject', async () => {
    const old = await documentV2('order.v1', 'order', orderBody());
    const otherSubject = await documentV2('order.v2', 'order', orderBody(), { version: 2, meta: { subjectId: 'SYN-OTHER', supersedes: ref('order') } });
    const path = '/documents/order.v2/metadata/supersedes';
    expect(await integrityReasons(inputV2([old, otherSubject]))).toEqual([reason('supersession_cross_subject', ref('order', 2), path)]);
    // Both endpoints agree with each other but not with the case.
    const oldOther = await documentV2('order.v1', 'order', orderBody(), { meta: { subjectId: 'SYN-OTHER' } });
    expect(await integrityReasons(inputV2([oldOther, otherSubject]))).toEqual([reason('supersession_cross_subject', ref('order', 2), path)]);
  });

  it('lets supplier status records, which have no subject, supersede each other', async () => {
    const old = await documentV2('supplier-status.v1', 'supplier-status', supplierBody());
    const next = await documentV2('supplier-status.v2', 'supplier-status', supplierBody(), { version: 2, meta: { supersedes: ref('supplier-status') } });
    expect(await superseded(inputV2([old, next]))).toEqual([ref('supplier-status')]);
  });

  it('reports both reasons for an edge that changes kind and subject', async () => {
    const old = await documentV2('record.v1', 'record', orderBody());
    const next = await documentV2('record.v2', 'record', supplierBody(), { version: 2, meta: { supersedes: ref('record') } });
    const path = '/documents/record.v2/metadata/supersedes';
    expect(await integrityReasons(inputV2([old, next]))).toEqual([
      reason('supersession_cross_kind', ref('record', 2), path),
      reason('supersession_cross_subject', ref('record', 2), path),
    ]);
  });

  it('orders reasons canonically and independently of the supplied order', async () => {
    const make = (documentId: string, version: number) => documentV2(`${documentId}.v${version}`, documentId, noteBody(), { version, payload: null });
    const documents = [await make('ord-9', 1), await make('ord-10', 1), await make('ord-1', 10), await make('ord-1', 9), await make('Ord-2', 1)];
    const expected = [ref('Ord-2'), ref('ord-1', 9), ref('ord-1', 10), ref('ord-10'), ref('ord-9')].map((documentRef) =>
      reason('document_bytes_missing', documentRef, `/documents/${documentRef.documentId}.v${documentRef.version}/payload`),
    );
    for (const ordering of reorderings(documents)) {
      expect(await integrityReasons(inputV2(ordering))).toEqual(expected);
    }
  });
});

describe('supersession lineage (C08, D5)', () => {
  it('supersedes every supplied target independently of array order, never by version number alone', async () => {
    const documents = [
      await documentV2('order.v1', 'order', orderBody()),
      await documentV2('order.v2', 'order', orderBody(), { version: 2, meta: { supersedes: ref('order') } }),
      await documentV2('order.v3', 'order', orderBody(), { version: 3, meta: { supersedes: ref('order') } }),
      await documentV2('encounter.v1', 'encounter', encounterBody()),
      await documentV2('encounter.v2', 'encounter', encounterBody(), { version: 2 }),
    ];
    for (const ordering of reorderings(documents)) {
      expect(await superseded(inputV2(ordering))).toEqual([ref('order')]);
    }
  });
});
