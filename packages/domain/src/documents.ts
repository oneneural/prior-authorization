import {
  type Case,
  type Document,
  type DocumentKind,
  type DocumentRef,
  EVIDENCE_FIELD_SOURCES,
  EvidenceField,
  type PolicyPack,
  SourceDocumentBody,
} from '@pa/contracts';

import { type Sha256Hasher } from './hash.js';
import { type JsonScalar, nodeAt, readJsonSource, type SourceNode } from './json-source.js';

/** One document version as supplied: its metadata and exact source bytes (`null` when restricted). */
export interface SourceInput {
  meta: Document;
  bytes: Uint8Array | null;
}

/** A value the document states at one evidence field's fixed pointer, with its source text. */
export interface ExtractedValue {
  field: EvidenceField;
  locator: string;
  value: string | number | boolean;
  originalText: string;
}

/**
 * R09 result for one document, decided before any rule reads a body.
 * `provenance_failed` covers a hash mismatch, a body kind that differs from the
 * metadata kind and a locator that does not resolve in the source text.
 */
export type Provenance =
  | {
      status: 'valid';
      /** The contract-parsed body; Zod trims its free-text strings. */
      body: SourceDocumentBody;
      /** The untransformed JSON value of the exact source text. */
      source: unknown;
      values: readonly ExtractedValue[];
    }
  | { status: 'restricted' }
  | { status: 'unreadable'; reason: string }
  | { status: 'provenance_failed'; reason: string };

export interface AssessedDocument {
  meta: Document;
  provenance: Provenance;
  /** R02 reasons, without any document content; empty unless quarantined. */
  quarantineReasons: readonly string[];
  /** Bound or exempt from binding, and provenance-valid (pack convention C05). */
  usable: boolean;
}

export const refOf = (meta: Document): DocumentRef => ({ documentId: meta.documentId, version: meta.version });
export const labelOf = (meta: Document) => `${meta.documentId} v${meta.version}`;
export const isQuarantined = (document: AssessedDocument) => document.quarantineReasons.length > 0;

const utf8 = new TextDecoder('utf-8', { fatal: true });

const FIELDS_BY_KIND = new Map<DocumentKind, EvidenceField[]>();
for (const field of EvidenceField.options) {
  const { documentKind } = EVIDENCE_FIELD_SOURCES[field];
  FIELDS_BY_KIND.set(documentKind, [...(FIELDS_BY_KIND.get(documentKind) ?? []), field]);
}

/** The parsed value at a pointer, or `undefined` when the pointer does not resolve. */
function parsedValueAt(body: unknown, pointer: string): unknown {
  let current = body;
  for (const token of pointer.slice(1).split('/')) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, token)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[token];
  }
  return current;
}

/**
 * Reads every evidence field of the body's kind from the source text. Each
 * value the untransformed JSON states must resolve to the same scalar at the
 * field's fixed pointer in an independent read of that exact text; otherwise
 * the locator does not resolve. The contract-parsed body is not compared,
 * because Zod trims free text and an authentic padded string would differ.
 */
function extractValues(kind: DocumentKind, json: unknown, source: SourceNode): ExtractedValue[] | undefined {
  const values: ExtractedValue[] = [];
  for (const field of FIELDS_BY_KIND.get(kind) ?? []) {
    const { pointer } = EVIDENCE_FIELD_SOURCES[field];
    const parsed = parsedValueAt(json, pointer);
    if (parsed === undefined || parsed === null) {
      continue;
    }
    const node = nodeAt(source, pointer);
    if (node?.kind !== 'scalar' || node.value !== (parsed as JsonScalar) || node.value === null) {
      return undefined;
    }
    values.push({ field, locator: pointer, value: node.value, originalText: typeof node.value === 'string' ? node.value : node.raw });
  }
  return values;
}

/**
 * R09 for one document: access, hash over the exact bytes, supported MIME type,
 * structured parse, kind and locators, in that order. It never judges whether
 * a clinical fact exists.
 */
export async function checkProvenance(input: SourceInput, pack: PolicyPack, sha256: Sha256Hasher): Promise<Provenance> {
  const { meta, bytes } = input;
  if (meta.accessStatus === 'restricted' || bytes === null) {
    return { status: 'restricted' };
  }
  if ((await sha256(bytes)) !== meta.contentHash) {
    return { status: 'provenance_failed', reason: 'its bytes differ from its contentHash' };
  }
  if (meta.accessStatus === 'unreadable') {
    return { status: 'unreadable', reason: 'the source system reports it unreadable' };
  }
  if (!pack.scope.documentMimeTypes.includes(meta.mimeType)) {
    return { status: 'unreadable', reason: `MIME type ${meta.mimeType} is not supported by this pack` };
  }
  let text: string;
  let json: unknown;
  let source: SourceNode;
  try {
    text = utf8.decode(bytes);
    json = JSON.parse(text);
    source = readJsonSource(text);
  } catch {
    return { status: 'unreadable', reason: 'its bytes are not valid UTF-8 JSON' };
  }
  const parsed = SourceDocumentBody.safeParse(json);
  if (!parsed.success) {
    return { status: 'unreadable', reason: 'its body is not a valid structured source body' };
  }
  if (parsed.data.documentKind !== meta.kind) {
    return { status: 'provenance_failed', reason: `its body kind ${parsed.data.documentKind} differs from its metadata kind ${meta.kind}` };
  }
  const values = extractValues(parsed.data.documentKind, json, source);
  if (values === undefined) {
    return { status: 'provenance_failed', reason: 'a locator does not resolve in this version' };
  }
  return { status: 'valid', body: parsed.data, source: json, values };
}

/** The case subject as supplied, before any contract transform. */
export type CaseSubject = Pick<Case, 'subjectId' | 'subjectName'>;

/**
 * R02, after R09 has classified the document (pack "order of checks"):
 * metadata naming another subject quarantines whatever the R09 result; a
 * provenance failure is excluded by R09 and its body is never compared; a
 * restricted or unreadable document binds by metadata alone; an available,
 * provenance-valid body binds only when every stated beneficiary identifier and
 * name in its exact source text equals the case subject exactly. Supplier
 * status records are exempt.
 */
export function quarantineReasons(meta: Document, provenance: Provenance, subject: CaseSubject): string[] {
  if (meta.kind === 'supplier_status') {
    return [];
  }
  if (meta.subjectId !== subject.subjectId) {
    return ['its metadata subjectId differs from the case subject'];
  }
  if (provenance.status !== 'valid' || provenance.body.documentKind === 'supplier_status') {
    return [];
  }
  const identifier = parsedValueAt(provenance.source, '/beneficiary/identifier');
  const name = parsedValueAt(provenance.source, '/beneficiary/name');
  const reasons: string[] = [];
  if (identifier !== null && identifier !== subject.subjectId) {
    reasons.push('its stated beneficiary identifier differs from the case subjectId');
  }
  if (name !== null && name !== subject.subjectName) {
    reasons.push('its stated beneficiary name differs from the case subjectName');
  }
  return reasons;
}

export async function assessDocuments(inputs: readonly SourceInput[], subject: CaseSubject, pack: PolicyPack, sha256: Sha256Hasher): Promise<AssessedDocument[]> {
  const documents: AssessedDocument[] = [];
  // Every document is classified by R09 before any body is compared by R02.
  const provenance = await Promise.all(inputs.map((input) => checkProvenance(input, pack, sha256)));
  inputs.forEach((input, index) => {
    const checked = provenance[index] as Provenance;
    const reasons = quarantineReasons(input.meta, checked, subject);
    documents.push({ meta: input.meta, provenance: checked, quarantineReasons: reasons, usable: reasons.length === 0 && checked.status === 'valid' });
  });
  return documents;
}
