import { loadFixture, sourceHash, validateSnapshot } from '@pa/connectors';
import { DocumentExact, EncounterBodyExact } from '@pa/contracts';

/** Original synthetic mutation; the stored fixture bytes remain unchanged. */
export async function kindMismatchCase() {
  const snapshot = await loadFixture('F01');
  snapshot.caseText = JSON.stringify({ ...JSON.parse(snapshot.caseText), caseId: 'case-f01-kind-mismatch' });
  const order = snapshot.documents.find((doc) => DocumentExact.parse(JSON.parse(doc.metadataText)).kind === 'order')!;
  const encounter = snapshot.documents.find((doc) => DocumentExact.parse(JSON.parse(doc.metadataText)).kind === 'encounter')!;
  const body = EncounterBodyExact.parse(JSON.parse(encounter.payload!));
  body.beneficiary = { name: 'Other Synthetic Person', identifier: 'SYN-OTHER' };
  order.payload = JSON.stringify(body);
  order.metadataText = JSON.stringify({ ...DocumentExact.parse(JSON.parse(order.metadataText)), contentHash: sourceHash(order.payload) });
  return validateSnapshot(snapshot);
}
