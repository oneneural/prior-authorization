import { expect, it } from 'vitest';

import { assessmentInput, loadFixture, sourceHash } from '@pa/connectors';
import { DocumentExact, OrderBodyExact } from '@pa/contracts';
import { assessV2 } from '@pa/domain';

import { kindMismatchCase } from '../../test/case-fixtures.js';
import { buildPacket, sourceAt } from './service.js';

it.each([
  ['F01', 'ready_for_review'], ['F02', 'needs_information'], ['F08a', 'needs_human_review'], ['F23', 'needs_human_review'], ['F28a', 'ready_for_review'],
] as const)('exports %s with independent administrative expectations', async (id, state) => {
  const snapshot = await loadFixture(id);
  const outcome = await assessV2(assessmentInput(snapshot));
  expect(outcome.outcome).toBe('assessed');
  if (outcome.outcome !== 'assessed') throw new Error('unexpected rejection');
  expect(outcome.result.state).toBe(state);
  const packet = buildPacket(snapshot, outcome)!;
  expect(packet.clinicalReviewRequired).toBe(true);
  expect(packet.clinicalReviewStatus).toBe('requires_qualified_review');
  expect(packet.mode).toBe('rules_only');
  const { packetHash, ...body } = packet;
  expect(sourceHash(JSON.stringify(body))).toBe(packetHash);
  expect(buildPacket(snapshot, outcome)).toEqual(packet);
  expect(packet.documents.every((doc) => doc.metadata.kind !== 'supporting_note')).toBe(true);
  for (const ref of outcome.result.quarantinedDocuments) expect(packet.documents.some((doc) => doc.metadata.documentId === ref.documentId && doc.metadata.version === ref.version)).toBe(false);
  for (const fact of packet.evidenceFacts) expect(sourceAt(snapshot, fact.documentId, fact.documentVersion, fact.locator).originalText).toBe(fact.originalText);
});

it('denies cross-case source identities, unavailable bytes and unknown locators', async () => {
  const snapshot = await loadFixture('F01');
  expect(() => sourceAt(snapshot, 'f23-order', 1)).toThrow();
  expect(() => sourceAt(snapshot, 'f01-order', 1, '/not-present')).toThrow();
});

it('omits an R09 kind-mismatch foreign body from the packet and denies raw and locator reads', async () => {
  const snapshot = await kindMismatchCase();
  const outcome = await assessV2(assessmentInput(snapshot));
  if (outcome.outcome !== 'assessed') throw new Error('unexpected rejection');
  expect(outcome.result.quarantinedDocuments).toEqual([]);
  const packet = buildPacket(snapshot, outcome)!;
  expect(packet.findings.find((finding) => finding.ruleId === 'R09')?.conditions).toContainEqual({ conditionKey: 'R09.kind_mismatch', field: null, documentRefs: [{ documentId: 'f01-order', version: 1 }] });
  expect(packet.includedDocumentRefs).not.toContainEqual({ documentId: 'f01-order', version: 1 });
  expect(packet.documents.some((doc) => doc.metadata.documentId === 'f01-order')).toBe(false);
  expect(packet.evidenceFacts.some((fact) => fact.documentId === 'f01-order')).toBe(false);
  expect(JSON.stringify(packet)).not.toMatch(/SYN-OTHER|Other Synthetic Person/);
  for (const pointer of [undefined, '/beneficiary/identifier']) expect(() => sourceAt(snapshot, 'f01-order', 1, pointer)).toThrow('case resource unavailable');
});

it.each(['invalid JSON', 'invalid body', 'foreign identifier', 'foreign name', 'unreadable', 'unsupported MIME'])(
  'denies raw and locator reads for %s despite matching metadata and hash', async (failure) => {
    const snapshot = await loadFixture('F01');
    const doc = snapshot.documents.find((candidate) => DocumentExact.parse(JSON.parse(candidate.metadataText)).kind === 'order')!;
    const metadata = DocumentExact.parse(JSON.parse(doc.metadataText));
    const body = OrderBodyExact.parse(JSON.parse(doc.payload!));
    if (failure === 'invalid JSON') doc.payload = '{';
    if (failure === 'invalid body') doc.payload = '{}';
    if (failure === 'foreign identifier' || failure === 'foreign name') {
      body.beneficiary[failure === 'foreign identifier' ? 'identifier' : 'name'] = 'OTHER';
      doc.payload = JSON.stringify(body);
    }
    if (failure === 'unreadable') metadata.accessStatus = 'unreadable';
    if (failure === 'unsupported MIME') metadata.mimeType = 'text/plain';
    doc.metadataText = JSON.stringify({ ...metadata, contentHash: sourceHash(doc.payload!) });
    for (const pointer of [undefined, '/beneficiary/identifier']) expect(() => sourceAt(snapshot, 'f01-order', 1, pointer)).toThrow('case resource unavailable');
  },
);
