import {
  type BINDING_BASES,
  type CaseV2,
  compareDocumentRefs,
  type DocumentExact,
  type DocumentKind,
  type DocumentRef,
  EVIDENCE_FIELD_SOURCES,
  EvidenceField,
  type PolicyPackV2,
  SourceDocumentBodyExact,
} from '@pa/contracts';

import { type Sha256Hasher } from '../hash.js';
import { nodeAt, readJsonSource, type SourceNode } from '../json-source.js';
import { refKey, refOf } from './lineage.js';
import { type ValidatedDocumentV2 } from './schema.js';

// Exact-version classification (D1, D3, C08, C09) for a snapshot that passed
// schema and integrity. Each supplied version is classified before any rule
// reads a body: R02 metadata binding first, then R09's first applicable
// condition, then R02 binding of an available verified body. Only a usable
// current version keeps its body and exact values; quarantined, unusable and
// superseded versions keep their metadata identity only, so no content leaks.

export type BindingBasis = (typeof BINDING_BASES)[number];

/** R09 conditions in the order they apply; `R09.locator_unresolved` is never emitted. */
export const R09_ORDER = ['R09.access_restricted', 'R09.hash_mismatch', 'R09.access_unreadable', 'R09.mime_unsupported', 'R09.body_invalid', 'R09.kind_mismatch'] as const;
export type R09Key = (typeof R09_ORDER)[number];

/** A value stated at one evidence field's fixed locator, with its exact source text. */
export interface ExactValue {
  field: EvidenceField;
  locator: string;
  value: string | number | boolean;
  /** The string as written, or the number or boolean token as written (`1.0` stays `1.0`). */
  originalText: string;
}

export interface UsableContent {
  body: SourceDocumentBodyExact;
  values: readonly ExactValue[];
}

export type VersionClass =
  /** R02: excluded on these binding bases; its body is never read again. */
  | { status: 'quarantined'; bases: readonly BindingBasis[] }
  /** R09: the first applicable condition; nothing is read from it. */
  | { status: 'r09'; conditionKey: R09Key }
  /** Bound or exempt and provenance-valid. `content` is `null` for a superseded version, which contributes nothing. */
  | { status: 'usable'; content: UsableContent | null };

export interface ClassifiedVersion {
  slot: string;
  ref: DocumentRef;
  metadata: DocumentExact;
  /** No applied supersession edge targets this version (C09 "current"). */
  current: boolean;
  classification: VersionClass;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

const FIELDS_BY_KIND = new Map<DocumentKind, EvidenceField[]>();
for (const field of EvidenceField.options) {
  const { documentKind } = EVIDENCE_FIELD_SOURCES[field];
  FIELDS_BY_KIND.set(documentKind, [...(FIELDS_BY_KIND.get(documentKind) ?? []), field]);
}

/**
 * Every non-null value the body's kind states at its evidence locators, from
 * the exact source text. The body already parsed with the exact contract, so
 * every stated locator holds a scalar.
 */
export function extractExactValues(kind: DocumentKind, source: SourceNode): ExactValue[] {
  const values: ExactValue[] = [];
  for (const field of FIELDS_BY_KIND.get(kind) ?? []) {
    const locator = EVIDENCE_FIELD_SOURCES[field].pointer;
    const node = nodeAt(source, locator);
    if (node === undefined || (node.kind === 'scalar' && node.value === null)) {
      continue;
    }
    if (node.kind !== 'scalar' || node.value === null) {
      throw new Error(`${field} does not hold a scalar in a body that passed the exact contract`);
    }
    values.push({ field, locator, value: node.value, originalText: typeof node.value === 'string' ? node.value : node.raw });
  }
  return values;
}

/** The exact body and its source tree, or `undefined` when the bytes are not a valid structured body. */
function readBody(bytes: Uint8Array): { body: SourceDocumentBodyExact; source: SourceNode } | undefined {
  try {
    const text = utf8.decode(bytes);
    const parsed = SourceDocumentBodyExact.safeParse(JSON.parse(text));
    return parsed.success ? { body: parsed.data, source: readJsonSource(text) } : undefined;
  } catch {
    return undefined;
  }
}

/** R02 bases on which an available verified body fails to bind: literal comparison of each stated value. */
function statedBindingBases(body: SourceDocumentBodyExact, subject: Pick<CaseV2, 'subjectId' | 'subjectName'>): BindingBasis[] {
  if (body.documentKind === 'supplier_status') {
    return [];
  }
  const bases: BindingBasis[] = [];
  if (body.beneficiary.identifier !== null && body.beneficiary.identifier !== subject.subjectId) {
    bases.push('binding.stated_identifier');
  }
  if (body.beneficiary.name !== null && body.beneficiary.name !== subject.subjectName) {
    bases.push('binding.stated_name');
  }
  return bases;
}

/**
 * Classifies one version. Metadata naming another subject quarantines it
 * whatever its provenance, without reading the body. Otherwise R09 applies its
 * first condition: declared restriction, then the hash over the exact bytes,
 * then declared unreadability (never rescued by valid bytes), then the MIME
 * type, then the exact body parse, then the body kind. A verified body binds
 * only when every stated beneficiary identifier and name equals the case's
 * exactly; supplier status records are exempt.
 */
export async function classifyVersion(
  document: ValidatedDocumentV2,
  context: { caseRecord: CaseV2; pack: PolicyPackV2; current: boolean },
  sha256: Sha256Hasher,
): Promise<VersionClass> {
  const { metadata, payload } = document;
  if (metadata.kind !== 'supplier_status' && metadata.subjectId !== context.caseRecord.subjectId) {
    return { status: 'quarantined', bases: ['binding.metadata_subject'] };
  }
  if (metadata.accessStatus === 'restricted' || payload === null) {
    return { status: 'r09', conditionKey: 'R09.access_restricted' };
  }
  if ((await sha256(payload)) !== metadata.contentHash) {
    return { status: 'r09', conditionKey: 'R09.hash_mismatch' };
  }
  if (metadata.accessStatus === 'unreadable') {
    return { status: 'r09', conditionKey: 'R09.access_unreadable' };
  }
  if (!context.pack.scope.documentMimeTypes.includes(metadata.mimeType)) {
    return { status: 'r09', conditionKey: 'R09.mime_unsupported' };
  }
  const read = readBody(payload);
  if (read === undefined) {
    return { status: 'r09', conditionKey: 'R09.body_invalid' };
  }
  if (read.body.documentKind !== metadata.kind) {
    return { status: 'r09', conditionKey: 'R09.kind_mismatch' };
  }
  const bases = statedBindingBases(read.body, context.caseRecord);
  if (bases.length > 0) {
    return { status: 'quarantined', bases };
  }
  return { status: 'usable', content: context.current ? { body: read.body, values: extractExactValues(read.body.documentKind, read.source) } : null };
}

/** Every supplied version, classified and in canonical reference order, independent of the supplied order. */
export async function classifySnapshot(
  documents: readonly ValidatedDocumentV2[],
  context: { caseRecord: CaseV2; pack: PolicyPackV2; superseded: ReadonlySet<string> },
  sha256: Sha256Hasher,
): Promise<ClassifiedVersion[]> {
  const ordered = [...documents].sort((a, b) => compareDocumentRefs(refOf(a.metadata), refOf(b.metadata)));
  return Promise.all(
    ordered.map(async (document) => {
      const ref = refOf(document.metadata);
      const current = !context.superseded.has(refKey(ref));
      const classification = await classifyVersion(document, { caseRecord: context.caseRecord, pack: context.pack, current }, sha256);
      return { slot: document.slot, ref, metadata: document.metadata, current, classification };
    }),
  );
}
