import { type DocumentKind, type SourceDocumentBodyExact } from '@pa/contracts';
import { describe, expect, it } from 'vitest';

import {
  assessed,
  citationsOf,
  conditionsOf,
  declaredUnreadable,
  encounter,
  note,
  order,
  packet,
  parentOf,
  plainText,
  READY,
  receipt,
  restricted,
  routingOf,
  sorted,
  statusesOf,
  supplier,
  tampered,
} from '../../test/builders-assess-v2.js';
import { type DocumentOptions, documentV2, encounterBody, noteBody, orderBody, receiptBody, SUBJECT_ID, SUBJECT_NAME, supplierBody } from '../../test/builders-v2.js';

// R02 (subject binding) and R09 (access and provenance) through `assessV2`,
// with exact-version quarantine (D3) and trusted supersession (C08, D5). Both
// rules classify every supplied version; only current usable versions supply
// facts.

const OTHER_SUBJECT = 'SYN-BEN-T99';
const encoder = new TextEncoder();

const BODIES: Record<DocumentKind, () => SourceDocumentBodyExact> = {
  order: () => orderBody(),
  encounter: () => encounterBody(),
  order_receipt: () => receiptBody(),
  supplier_status: () => supplierBody(),
  supporting_note: () => noteBody(),
};
const SUBJECT_KINDS: DocumentKind[] = ['order', 'encounter', 'order_receipt', 'supporting_note'];
const ALL_KINDS: DocumentKind[] = [...SUBJECT_KINDS, 'supplier_status'];

/** Metadata of one kind, with the subject its kind requires. */
const metaOf = (kind: DocumentKind, options: DocumentOptions = {}): DocumentOptions => ({
  ...options,
  meta: { kind, subjectId: kind === 'supplier_status' ? null : SUBJECT_ID, sourceSystem: kind === 'supplier_status' ? 'supplier_compliance' : 'practitioner_record', ...options.meta },
});

/** A version of `kind` with the given body (bytes or a body of possibly another kind). */
const versionOf = (kind: DocumentKind, body: SourceDocumentBodyExact | Uint8Array, options: DocumentOptions = {}) => documentV2(`x-${kind}.v1`, `x-${kind}`, body, metaOf(kind, options));

describe('R02 subject binding and exact-version quarantine', () => {
  it.each(SUBJECT_KINDS)('quarantines a %s on metadata subject alone, without hashing or comparing its body', async (kind) => {
    // The body also names another person and the bytes fail their hash: only metadata_subject is reported.
    const body = { ...BODIES[kind](), beneficiary: { name: 'Another Person', identifier: OTHER_SUBJECT } } as SourceDocumentBodyExact;
    const result = await assessed([...(await packet()), await versionOf(kind, body, tampered({ meta: { subjectId: OTHER_SUBJECT } }))]);
    expect(conditionsOf(result, 'R02')).toEqual([`R02.document_quarantined|binding.metadata_subject|x-${kind}@1`]);
    expect(routingOf(result, 'R02')).toBe('conflict/administrative_reviewer');
    expect(parentOf(result, 'R02')).toEqual([`x-${kind}@1`]);
    expect(result.quarantinedDocuments).toEqual([{ documentId: `x-${kind}`, version: 1 }]);
    expect(conditionsOf(result, 'R09')).toEqual([]);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_human_review', R02: 'conflict' });
    expect(result.evidenceFacts.some((fact) => fact.documentId === `x-${kind}`)).toBe(false);
  });

  const STATED: [string, { name: string | null; identifier: string | null }, string[]][] = [
    ['another identifier', { name: SUBJECT_NAME, identifier: OTHER_SUBJECT }, ['binding.stated_identifier']],
    ['a padded name', { name: ` ${SUBJECT_NAME}`, identifier: SUBJECT_ID }, ['binding.stated_name']],
    ['a case-changed name', { name: SUBJECT_NAME.toUpperCase(), identifier: SUBJECT_ID }, ['binding.stated_name']],
    ['a doubled inner space', { name: SUBJECT_NAME.replace(' ', '  '), identifier: null }, ['binding.stated_name']],
    ['both differing', { name: 'Another Person', identifier: OTHER_SUBJECT }, ['binding.stated_identifier', 'binding.stated_name']],
  ];

  it.each(STATED)('quarantines an available verified body stating %s, once per failing basis', async (_label, beneficiary, bases) => {
    const result = await assessed([...(await packet()), await note('note', { beneficiary })]);
    expect(conditionsOf(result, 'R02')).toEqual(bases.map((basis) => `R02.document_quarantined|${basis}|note@1`));
    expect(parentOf(result, 'R02')).toEqual(['note@1']);
    expect(conditionsOf(result, 'R09')).toEqual([]);
  });

  it.each([
    ['the name alone', { name: SUBJECT_NAME, identifier: null }],
    ['the identifier alone', { name: null, identifier: SUBJECT_ID }],
    ['neither (metadata binding)', { name: null, identifier: null }],
  ])('binds a body stating %s', async (_label, beneficiary) => {
    const result = await assessed([...(await packet()), await note('note', { beneficiary })]);
    expect(routingOf(result, 'R02')).toBe('pass/administrative_reviewer');
    expect(result.quarantinedDocuments).toEqual([]);
  });

  it('binds an unavailable or unverified version by its metadata only, never comparing its body', async () => {
    const otherName = { beneficiary: { name: 'Another Person', identifier: OTHER_SUBJECT } };
    const result = await assessed([...(await packet()), await note('note-hash', otherName, tampered()), await note('note-unreadable', otherName, declaredUnreadable()), await note('note-restricted', {}, restricted())]);
    expect(conditionsOf(result, 'R02')).toEqual([]);
    expect(conditionsOf(result, 'R09')).toEqual(['R09.access_restricted|-|note-restricted@1', 'R09.access_unreadable|-|note-unreadable@1', 'R09.hash_mismatch|-|note-hash@1']);
  });

  it('never binds a supplier status record to a beneficiary', async () => {
    const result = await assessed(await packet());
    expect(result.quarantinedDocuments).toEqual([]);
    expect(conditionsOf(result, 'R02')).toEqual([]);
  });

  it.each([
    ['the older', 1],
    ['the newer', 2],
  ])('quarantines only %s version of a mixed-version ID, leaving the other usable', async (_label, quarantinedVersion) => {
    const misnamed = { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } };
    const versions = [await order('order', quarantinedVersion === 1 ? misnamed : {}, { version: 1 }), await order('order', quarantinedVersion === 2 ? misnamed : {}, { version: 2 })];
    const result = await assessed([...versions, await encounter(), await receipt('receipt', { orderReference: { documentId: 'order', version: 3 - quarantinedVersion } }), await supplier()]);
    const usable = 3 - quarantinedVersion;
    expect(result.quarantinedDocuments).toEqual([{ documentId: 'order', version: quarantinedVersion }]);
    expect(conditionsOf(result, 'R02')).toEqual([`R02.document_quarantined|binding.stated_name|order@${String(quarantinedVersion)}`]);
    expect(new Set(result.evidenceFacts.filter((fact) => fact.documentId === 'order').map((fact) => fact.documentVersion))).toEqual(new Set([usable]));
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_human_review', R02: 'conflict' });
    expect(citationsOf(result, 'R03').every((citation) => citation.startsWith(`order@${String(usable)}/`))).toBe(true);
  });

  it('lists a quarantined superseded version in both lists and names it only in R02', async () => {
    const result = await assessed([
      await order('order', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }),
      await encounter(),
      await receipt('receipt', { orderReference: { documentId: 'order', version: 2 } }),
      await supplier(),
    ]);
    expect(result.quarantinedDocuments).toEqual([{ documentId: 'order', version: 1 }]);
    expect(result.supersededDocuments).toEqual([{ documentId: 'order', version: 1 }]);
    const naming = result.findings.filter((finding) =>
      [...finding.documentRefs, ...finding.conditions.flatMap((condition) => condition.documentRefs)].some((ref) => ref.documentId === 'order' && ref.version === 1),
    );
    expect(naming.map((finding) => finding.ruleId)).toEqual(['R02']);
  });

  it('cites stated beneficiary facts from every current usable subject-scoped version and leaks no quarantined content', async () => {
    const marker = 'LEAK-MARKER-TEXT';
    const result = await assessed([
      ...(await packet()),
      await note('note'),
      await note('note-misnamed', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID }, title: marker, text: marker }, { meta: { syntheticProvenance: { origin: 'authored_synthetic', statement: marker } } }),
    ]);
    expect(citationsOf(result, 'R02')).toEqual(
      sorted(['order', 'encounter', 'receipt', 'note'].flatMap((documentId) => [`${documentId}@1/beneficiary/identifier`, `${documentId}@1/beneficiary/name`])),
    );
    expect(JSON.stringify(result)).not.toContain(marker);
    expect(JSON.stringify(result)).not.toContain('Another Person');
    expect(JSON.stringify(result)).not.toContain('Synthetic unit test document.');
  });
});

describe('R09 first applicable condition per version', () => {
  const KEYS: [string, string, (kind: DocumentKind) => ReturnType<typeof versionOf>][] = [
    ['R09.hash_mismatch', 'conflict/administrative_reviewer', (kind) => versionOf(kind, BODIES[kind](), tampered())],
    ['R09.kind_mismatch', 'conflict/administrative_reviewer', (kind) => versionOf(kind, kind === 'supporting_note' ? orderBody() : noteBody())],
    ['R09.access_restricted', 'restricted/authorization_coordinator', (kind) => versionOf(kind, BODIES[kind](), restricted())],
    ['R09.access_unreadable', 'unreadable/authorization_coordinator', (kind) => versionOf(kind, BODIES[kind](), declaredUnreadable())],
    ['R09.mime_unsupported', 'unreadable/authorization_coordinator', (kind) => versionOf(kind, BODIES[kind](), plainText())],
    ['R09.body_invalid', 'unreadable/authorization_coordinator', (kind) => versionOf(kind, encoder.encode('{"documentKind":'))],
  ];
  const MATRIX = KEYS.flatMap(([key, routing, build]) => ALL_KINDS.map((kind) => [key, kind, routing, build] as const));

  it.each(MATRIX)('holds %s for a %s version, names it and takes no fact from it', async (key, kind, routing, build) => {
    const result = await assessed([...(await packet()), await build(kind)]);
    expect(conditionsOf(result, 'R09')).toEqual([`${key}|-|x-${kind}@1`]);
    expect(routingOf(result, 'R09')).toBe(routing);
    expect(parentOf(result, 'R09')).toEqual([`x-${kind}@1`]);
    expect(result.evidenceFacts.some((fact) => fact.documentId === `x-${kind}`)).toBe(false);
    expect(citationsOf(result, 'R09')).toEqual([]);
  });

  it('hashes before parsing, never rescues declared unreadability and checks the MIME type before the body', async () => {
    const invalid = encoder.encode('not json');
    const result = await assessed([
      ...(await packet()),
      await note('note-hash-invalid', {}, { payload: invalid }),
      await note('note-declared', {}, declaredUnreadable()),
      await note('note-declared-hash', {}, declaredUnreadable(tampered())),
      await documentV2('note-mime-invalid.v1', 'note-mime-invalid', invalid, metaOf('supporting_note', plainText())),
    ]);
    expect(conditionsOf(result, 'R09')).toEqual([
      'R09.access_unreadable|-|note-declared@1',
      'R09.hash_mismatch|-|note-declared-hash@1',
      'R09.hash_mismatch|-|note-hash-invalid@1',
      'R09.mime_unsupported|-|note-mime-invalid@1',
    ]);
  });

  it('takes the conflict status and names every affected version, keeping lower-priority conditions', async () => {
    const result = await assessed([...(await packet()), await note('note-hash', {}, tampered()), await note('note-restricted', {}, restricted()), await note('note-unreadable', {}, declaredUnreadable())]);
    expect(routingOf(result, 'R09')).toBe('conflict/administrative_reviewer');
    expect(parentOf(result, 'R09')).toEqual(['note-hash@1', 'note-restricted@1', 'note-unreadable@1']);
    expect(result.state).toBe('needs_human_review');
  });

  it('takes the restricted status above unreadable and names both versions', async () => {
    const result = await assessed([...(await packet()), await note('note-restricted', {}, restricted()), await note('note-unreadable', {}, declaredUnreadable())]);
    expect(routingOf(result, 'R09')).toBe('restricted/authorization_coordinator');
    expect(parentOf(result, 'R09')).toEqual(['note-restricted@1', 'note-unreadable@1']);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_information', R09: 'restricted' });
  });

  it('leaves a metadata-quarantined version to R02 alone', async () => {
    const result = await assessed([...(await packet()), await note('note', {}, restricted({ meta: { subjectId: OTHER_SUBJECT } }))]);
    expect(conditionsOf(result, 'R09')).toEqual([]);
    expect(conditionsOf(result, 'R02')).toEqual(['R02.document_quarantined|binding.metadata_subject|note@1']);
  });

  it('still classifies a superseded restricted version, which blocks this snapshot (recorded limitation)', async () => {
    const result = await assessed([
      await order('order', {}, restricted()),
      await order('order', {}, { version: 2, meta: { supersedes: { documentId: 'order', version: 1 } } }),
      await encounter(),
      await receipt('receipt', { orderReference: { documentId: 'order', version: 2 } }),
      await supplier(),
    ]);
    expect(conditionsOf(result, 'R09')).toEqual(['R09.access_restricted|-|order@1']);
    expect(parentOf(result, 'R09')).toEqual(['order@1']);
    expect(result.supersededDocuments).toEqual([{ documentId: 'order', version: 1 }]);
    expect(statusesOf(result)).toEqual({ ...READY, state: 'needs_information', R09: 'restricted' });
  });
});

describe('trusted supersession (C08, D5)', () => {
  const superseding = (options: DocumentOptions = {}): DocumentOptions => ({ ...options, version: 2, meta: { ...options.meta, supersedes: { documentId: 'order', version: 1 } } });
  const rest = async () => [await encounter(), await receipt('receipt', { orderReference: { documentId: 'order', version: 2 } }), await supplier()];

  it('reads only the superseder: the superseded version supplies no fact, citation or condition', async () => {
    const result = await assessed([await order('order', { signature: null }), await order('order', {}, superseding()), ...(await rest())]);
    expect(result.supersededDocuments).toEqual([{ documentId: 'order', version: 1 }]);
    expect(conditionsOf(result, 'R03')).toEqual([]);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'order' && fact.documentVersion === 1)).toBe(false);
    expect(statusesOf(result)).toEqual(READY);
  });

  it('infers no supersession from a larger version number', async () => {
    const result = await assessed([await order('order', { signature: null }), await order('order', {}, { version: 2 }), ...(await rest())]);
    expect(result.supersededDocuments).toEqual([]);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.element_missing|element.signature|order@1']);
  });

  const UNUSABLE: [string, DocumentOptions, string[], string[]][] = [
    ['restricted', restricted(superseding()), ['R03.order_restricted|-|order@2'], ['R09.access_restricted|-|order@2']],
    ['unreadable', declaredUnreadable(superseding()), ['R03.order_unreadable|-|order@2'], ['R09.access_unreadable|-|order@2']],
    ['failed provenance', tampered(superseding()), ['R03.order_failed_provenance|-|order@2'], ['R09.hash_mismatch|-|order@2']],
  ];

  it.each(UNUSABLE)('never reactivates the old order behind a %s superseder', async (_label, options, r03, r09) => {
    const result = await assessed([await order('order'), await order('order', {}, options), ...(await rest())]);
    expect(conditionsOf(result, 'R03')).toEqual(r03);
    expect(conditionsOf(result, 'R09')).toEqual(r09);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.no_usable_order|-|']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'order')).toBe(false);
  });

  it('never reactivates the old order behind a superseder quarantined on its verified body', async () => {
    const result = await assessed([await order('order'), await order('order', { beneficiary: { name: 'Another Person', identifier: SUBJECT_ID } }, superseding()), ...(await rest())]);
    expect(conditionsOf(result, 'R02')).toEqual(['R02.document_quarantined|binding.stated_name|order@2']);
    expect(conditionsOf(result, 'R03')).toEqual(['R03.no_usable_order|-|']);
    expect(conditionsOf(result, 'R04')).toEqual(['R04.no_usable_order|-|']);
    expect(conditionsOf(result, 'R05')).toEqual(['R05.no_usable_order|-|']);
    expect(result.evidenceFacts.some((fact) => fact.documentId === 'order')).toBe(false);
  });
});
