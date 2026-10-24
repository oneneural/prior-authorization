import {
  AssessmentOutcomeV3,
  type AssessmentResultV3,
  type EncounterBody,
  type EvidenceField,
  type FindingV3,
  type OrderBody,
  type OrderReceiptBody,
  type PolicyPackV2,
  type RuleId,
  type SupplierStatusBody,
  type SupportingNoteBody,
} from '@pa/contracts';

import { type Sha256Hasher } from '../src/hash.js';
import { assessV2 } from '../src/index.js';
import { type AssessV2Options, FORCING_SEAM, type ForcingSeam } from '../src/v2/assess.js';
import { type DocumentInputV2 } from '../src/v2/input.js';
import { documentV2, type DocumentOptions, encounterBody, inputV2, type InputOptions, noteBody, orderBody, packV2, receiptBody, supplierBody } from './builders-v2.js';

// Helpers for direct-input `assessV2` tests. Every input is original
// synthetic data built in memory; nothing reads a fixture, oracle or pack
// file. The citing pack is the part A test pack with synthetic evidence
// fields per rule and one synthetic source, so R08 passes and C05 citations
// can be observed. Results are reduced to plain strings so that expectations
// are stated independently of generated IDs.

/** Evidence fields per rule for the citing test pack, following the field vocabulary in docs/policy-slice.md. */
export const TEST_EVIDENCE_FIELDS: Record<RuleId, EvidenceField[]> = {
  R01: ['supplier.id', 'supplier.status', 'supplier.established', 'supplier.new_enrollment', 'supplier.ownership_change', 'supplier.effective_from', 'supplier.effective_to', 'order.item_code'],
  R02: [
    'order.beneficiary_name',
    'order.beneficiary_identifier',
    'encounter.beneficiary_name',
    'encounter.beneficiary_identifier',
    'receipt.beneficiary_name',
    'receipt.beneficiary_identifier',
    'note.beneficiary_name',
    'note.beneficiary_identifier',
  ],
  R03: [
    'order.beneficiary_name',
    'order.beneficiary_identifier',
    'order.date',
    'order.item_description',
    'order.quantity',
    'order.practitioner_name',
    'order.practitioner_identifier',
    'order.signature_signer_name',
    'order.signature_date',
  ],
  R04: ['encounter.status', 'encounter.date', 'encounter.completion_timestamp', 'encounter.practitioner_identifier', 'order.status', 'order.date', 'order.timestamp', 'order.practitioner_identifier'],
  R05: ['receipt.order_document_id', 'receipt.order_document_version', 'receipt.received_at', 'order.date', 'order.timestamp'],
  R06: ['clinical.diagnosis_statement', 'clinical.mobility_limitation', 'clinical.lower_level_devices', 'clinical.home_accessibility', 'clinical.ability_to_operate'],
  R07: ['encounter.lcmp_report_incorporated', 'encounter.lcmp_evaluation_date'],
  R08: [],
  R09: [],
  R10: [],
};

/** The part A test pack with evidence fields and one synthetic source reference. */
export function citingPackV2(): PolicyPackV2 {
  const pack = packV2();
  for (const rule of pack.rules) {
    rule.evidenceFields = TEST_EVIDENCE_FIELDS[rule.ruleId];
  }
  pack.sourceRefs = [
    {
      sourceRefId: 'S01',
      title: 'Synthetic test source',
      publisher: 'Synthetic test publisher',
      url: 'https://example.org/synthetic-test-source',
      retrievedOn: '2026-10-18',
      effectiveOn: null,
      updatedOn: null,
      version: null,
      usedFor: 'Synthetic unit tests.',
      limitation: 'Not a real policy source.',
    },
  ];
  return pack;
}

const slotOf = (documentId: string, options: DocumentOptions) => `${documentId}.v${String(options.version ?? 1)}`;

export const order = (documentId = 'order', body: Partial<OrderBody> = {}, options: DocumentOptions = {}) => documentV2(slotOf(documentId, options), documentId, orderBody(body), options);
export const encounter = (documentId = 'encounter', body: Partial<EncounterBody> = {}, options: DocumentOptions = {}) =>
  documentV2(slotOf(documentId, options), documentId, encounterBody(body), options);
export const receipt = (documentId = 'receipt', body: Partial<OrderReceiptBody> = {}, options: DocumentOptions = {}) =>
  documentV2(slotOf(documentId, options), documentId, receiptBody(body), options);
export const supplier = (documentId = 'supplier-status', body: Partial<SupplierStatusBody> = {}, options: DocumentOptions = {}) =>
  documentV2(slotOf(documentId, options), documentId, supplierBody(body), options);
export const note = (documentId = 'note', body: Partial<SupportingNoteBody> = {}, options: DocumentOptions = {}) => documentV2(slotOf(documentId, options), documentId, noteBody(body), options);

/** Metadata options for a version whose held bytes are not the body its hash covers (R09 hash mismatch). */
export const tampered = (options: DocumentOptions = {}): DocumentOptions => ({ ...options, payload: new TextEncoder().encode('{"tampered":true}') });
export const restricted = (options: DocumentOptions = {}): DocumentOptions => ({ ...options, meta: { ...options.meta, accessStatus: 'restricted' } });
export const declaredUnreadable = (options: DocumentOptions = {}): DocumentOptions => ({ ...options, meta: { ...options.meta, accessStatus: 'unreadable' } });
export const plainText = (options: DocumentOptions = {}): DocumentOptions => ({ ...options, meta: { ...options.meta, mimeType: 'text/plain' } });

/** The supported packet: final order, final encounter, a following receipt and the named supplier record. */
export async function packet(): Promise<DocumentInputV2[]> {
  return [await order(), await encounter(), await receipt(), await supplier()];
}

export interface AssessOptions extends InputOptions {
  seam?: ForcingSeam;
  sha256?: Sha256Hasher;
}

/** `assessV2` on synthetic documents with the citing pack unless another pack is given. */
export function assessDocuments(documents: readonly DocumentInputV2[], options: AssessOptions = {}): Promise<AssessmentOutcomeV3> {
  const { seam, sha256, ...input } = options;
  const assessOptions = { ...(sha256 === undefined ? {} : { sha256 }), ...(seam === undefined ? {} : { [FORCING_SEAM]: seam }) } as AssessV2Options;
  return assessV2(inputV2(documents, input.pack === undefined && input.packBytes === undefined ? { ...input, pack: citingPackV2() } : input), assessOptions);
}

/** The assessed result, after checking the envelope against the frozen contract. */
export async function assessed(documents: readonly DocumentInputV2[], options: AssessOptions = {}): Promise<AssessmentResultV3> {
  const outcome = await assessDocuments(documents, options);
  if (!AssessmentOutcomeV3.safeParse(outcome).success) {
    throw new Error('assessV2 returned an envelope outside the contract');
  }
  if (outcome.outcome !== 'assessed') {
    throw new Error(`expected an assessed result, got ${JSON.stringify(outcome.rejection)}`);
  }
  return outcome.result;
}

export function findingOf(result: AssessmentResultV3, ruleId: RuleId): FindingV3 {
  const finding = result.findings.find((candidate) => candidate.ruleId === ruleId);
  if (finding === undefined) {
    throw new Error(`no ${ruleId} finding`);
  }
  return finding;
}

const refText = (ref: { documentId: string; version: number }) => `${ref.documentId}@${String(ref.version)}`;

/** Each condition as `key|field|ref,ref` (`-` for a null field), sorted as strings; the contract already checks canonical order. */
export const conditionsOf = (result: AssessmentResultV3, ruleId: RuleId) =>
  findingOf(result, ruleId)
    .conditions.map((condition) => `${condition.conditionKey}|${condition.field ?? '-'}|${condition.documentRefs.map(refText).join(',')}`)
    .sort();

/** Expected condition strings, sorted the same way. */
export const sorted = (values: readonly string[]) => [...values].sort();

/** The finding's status and responsible role. */
export const routingOf = (result: AssessmentResultV3, ruleId: RuleId) => `${findingOf(result, ruleId).status}/${findingOf(result, ruleId).responsibleRole}`;

/** The finding's parent references (C07). */
export const parentOf = (result: AssessmentResultV3, ruleId: RuleId) => findingOf(result, ruleId).documentRefs.map(refText);

/** Each citation as `id@version/locator`, sorted, resolved through the result's facts. */
export function citationsOf(result: AssessmentResultV3, ruleId: RuleId): string[] {
  const facts = new Map(result.evidenceFacts.map((fact) => [fact.factId, fact]));
  return findingOf(result, ruleId)
    .evidenceFactIds.map((factId) => {
      const fact = facts.get(factId);
      return fact === undefined ? `dangling:${factId}` : `${fact.documentId}@${String(fact.documentVersion)}${fact.locator}`;
    })
    .sort();
}

/** Every finding's status, keyed by rule, plus the state. */
export function statusesOf(result: AssessmentResultV3): Record<string, string> {
  return { state: result.state, ...Object.fromEntries(result.findings.map((finding) => [finding.ruleId, finding.status])) };
}

/** The statuses of the supported packet; tests override only what they change. */
export const READY: Record<string, string> = {
  state: 'ready_for_review',
  R01: 'pass',
  R02: 'pass',
  R03: 'pass',
  R04: 'pass',
  R05: 'pass',
  R06: 'manual_review',
  R07: 'pass',
  R08: 'pass',
  R09: 'pass',
  R10: 'not_applicable',
};
