import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { relative, resolve, sep } from 'node:path';

import { CaseSnapshot, DocumentExact, IntakeCaseV2, PolicyPackV2 } from '@pa/contracts';
import { assertAdapterContract, type AssessmentInputV2 } from '@pa/domain';

export const FIXTURE_IDS = ['F01', 'F02', 'F08a', 'F23', 'F28a'] as const;
export type FixtureId = typeof FIXTURE_IDS[number] | 'F05b';
export const sourceHash = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex');
const bytes = (text: string) => new TextEncoder().encode(text);

export function assessmentInput(snapshot: CaseSnapshot): AssessmentInputV2 {
  const record = IntakeCaseV2.parse(JSON.parse(snapshot.caseText));
  return {
    caseBytes: bytes(snapshot.caseText), policyPackBytes: bytes(snapshot.policyText), assessmentDate: record.assessmentDate,
    documents: snapshot.documents.map((doc) => ({ slot: doc.slot, metadata: bytes(doc.metadataText), payload: doc.payload === null ? null : bytes(doc.payload) })),
  };
}

/** Trusted ingestion boundary, used before any domain persistence or assessment. */
export function validateSnapshot(value: unknown): CaseSnapshot {
  const snapshot = CaseSnapshot.parse(value);
  if (Buffer.byteLength(snapshot.caseText) > 32_768 || Buffer.byteLength(snapshot.policyText) > 524_288) throw new Error('input byte limit exceeded');
  const record = IntakeCaseV2.parse(JSON.parse(snapshot.caseText));
  const policy = PolicyPackV2.parse(JSON.parse(snapshot.policyText));
  if (record.policyPackId !== policy.packId) throw new Error('policy reference mismatch');
  const identities = new Set<string>();
  for (const doc of snapshot.documents) {
    if (Buffer.byteLength(doc.metadataText) > 16_384) throw new Error('metadata byte limit exceeded');
    const meta = DocumentExact.parse(JSON.parse(doc.metadataText));
    const key = `${meta.documentId}@${meta.version}`;
    if (identities.has(key)) throw new Error('duplicate document version');
    identities.add(key);
    if ((meta.accessStatus === 'restricted') !== (doc.payload === null)) throw new Error('source access mismatch');
    if (doc.payload !== null && Buffer.byteLength(doc.payload) > 1_048_576) throw new Error('source byte limit exceeded');
    if (doc.payload !== null && (sourceHash(doc.payload) !== meta.contentHash || /<\s*(script|html)\b/i.test(doc.payload))) throw new Error('unsupported source bytes');
  }
  assertAdapterContract(assessmentInput(snapshot));
  return snapshot;
}

const ROOT = fileURLToPath(new URL('../fixtures/', import.meta.url));

/** No caller-supplied path reaches this function. Refuse symlinks and bound bytes before reading. */
async function readBounded(path: string, maxBytes: number): Promise<string> {
  const absolute = resolve(ROOT, path);
  const actual = await realpath(absolute);
  const rel = relative(await realpath(ROOT), actual);
  if (rel === '..' || rel.startsWith(`..${sep}`) || resolve(ROOT, rel) !== absolute) throw new Error('fixture path outside root');
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw new Error('invalid fixture file');
  const content = await readFile(absolute);
  if (content.byteLength > maxBytes) throw new Error('fixture byte limit exceeded');
  return new TextDecoder('utf-8', { fatal: true }).decode(content);
}

export async function loadFixture(id: FixtureId): Promise<CaseSnapshot> {
  if (id !== 'F05b' && !(FIXTURE_IDS as readonly string[]).includes(id)) throw new Error('unknown fixture');
  const directory = `${id}/documents`;
  const names = await readdir(resolve(ROOT, directory));
  if (names.length > 100 || names.some((name) => !/^[a-zA-Z0-9._-]+\.json$/.test(name))) throw new Error('invalid fixture files');
  const metadata = names.filter((name) => name.endsWith('.meta.json')).sort();
  if (metadata.length > 50) throw new Error('document count exceeded');
  const documents: CaseSnapshot['documents'] = [];
  for (const name of metadata) {
    const metadataText = await readBounded(`${directory}/${name}`, 16_384);
    const meta = DocumentExact.parse(JSON.parse(metadataText));
    const payload = meta.accessStatus === 'restricted' ? null : await readBounded(`${directory}/${name.replace('.meta.json', '.json')}`, 1_048_576);
    documents.push({ slot: name.slice(0, -10), metadataText, payload });
  }
  return validateSnapshot({ caseText: await readBounded(`${id}/case.json`, 32_768), policyText: await readBounded('policy.json', 524_288), documents });
}
