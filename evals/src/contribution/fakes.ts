import { type AgentLimits, type AgentProvider } from '@pa/agents';
import { EVIDENCE_FIELD_SOURCES, type EvidenceField } from '@pa/contracts';
import { nodeAt, readJsonSource } from '@pa/domain';

import { type CaseSnapshot, RUN_PLAN_LIMITS, type SourceDocument } from './adapter.js';

// Contribution evaluator-only fakes. Each is a fixed turn script built from the case
// bytes and the authoritative rules outcome the policy tool also returns, never
// from gold. They exercise the graph, gate and scorer; they are labelled
// `fake:<name>` and are never model evidence. A perturbation names the one case
// it changes; every other case runs the complete reader unchanged.

/** A provider turn that rejects instead of answering: a refusal or provider error. */
export const FAIL = Symbol('fake provider failure');
type Turn = unknown;

/** Enough turns and tools for the complete reader on every case, so its misses are scorer facts, not budget stops. */
export const FAKE_LIMITS: AgentLimits = { ...RUN_PLAN_LIMITS, maxModelCalls: 24, maxToolCalls: 24 };

interface Candidate { field: EvidenceField; documentId: string; documentVersion: number; locator: string; value: string | number | boolean; originalText: string; confidence: number; sourceContentHash: string }
interface RequestCandidate { findingId: string; templateId: string; recipientRole: string }
interface Plan { reads: SourceDocument[]; facts: Candidate[]; requests: RequestCandidate[]; prefix: Turn[] }

const TEMPLATE_FOR_RULE = {
  R03: { templateId: 'existing_order', recipientRole: 'practitioner_records', keys: ['R03.no_usable_order', 'R03.element_missing'] },
  R04: { templateId: 'existing_encounter', recipientRole: 'practitioner_records', keys: ['R04.no_usable_encounter', 'R04.encounter_not_final'] },
  R05: { templateId: 'existing_receipt', recipientRole: 'supplier_records', keys: ['R05.order_receipt_missing'] },
} as const;

const call = (tool: string, input: Record<string, unknown> = {}) => ({ type: 'call_tool', tool, input });

function scalarAt(payload: string, pointer: string) {
  const node = nodeAt(readJsonSource(payload), pointer);
  return node?.kind === 'scalar' && node.value !== null ? { value: node.value, originalText: typeof node.value === 'string' ? node.value : node.raw } : undefined;
}

/** What the evaluator port lists as readable: available bytes not withheld by quarantine or R09. */
function readable(snapshot: CaseSnapshot): SourceDocument[] {
  const withheld = (doc: SourceDocument) => {
    const matches = (ref: { documentId: string; version: number }) => ref.documentId === doc.metadata.documentId && ref.version === doc.metadata.version;
    return snapshot.outcome.quarantinedDocuments.some(matches)
      || snapshot.outcome.findings.some((finding) => finding.ruleId === 'R09' && finding.conditions.some((condition) => condition.documentRefs.some(matches)));
  };
  return snapshot.documents.filter((doc) => doc.payload !== null && doc.metadata.accessStatus === 'available' && !withheld(doc));
}

function exactCandidates(doc: SourceDocument): Candidate[] {
  return (Object.entries(EVIDENCE_FIELD_SOURCES) as [EvidenceField, { documentKind: string; pointer: string }][])
    .filter(([, source]) => source.documentKind === doc.metadata.kind)
    .flatMap(([field, source]) => {
      const found = scalarAt(doc.payload!, source.pointer);
      return found === undefined ? [] : [{
        field, documentId: doc.metadata.documentId, documentVersion: doc.metadata.version, locator: source.pointer,
        value: found.value, originalText: found.originalText, confidence: 0.9, sourceContentHash: doc.metadata.contentHash!,
      }];
    });
}

/**
 * The generic complete reader: read every readable supplier record and receipt,
 * propose every exact scalar of the supplier records and of receipts that name a
 * document present in the case, and request every missing finding whose
 * conditions the matching template covers.
 */
export function completePlan(snapshot: CaseSnapshot): Plan {
  const docs = readable(snapshot);
  const present = new Set(snapshot.documents.map((doc) => doc.metadata.documentId));
  const reads = docs.filter((doc) => doc.metadata.kind === 'supplier_status' || doc.metadata.kind === 'order_receipt');
  const linked = (doc: SourceDocument) => {
    if (doc.metadata.kind !== 'order_receipt') return true;
    const target = scalarAt(doc.payload!, '/orderReference/documentId');
    return target !== undefined && present.has(String(target.value));
  };
  const requests = snapshot.outcome.findings.flatMap((finding) => {
    const template = TEMPLATE_FOR_RULE[finding.ruleId as keyof typeof TEMPLATE_FOR_RULE];
    const keys = finding.conditions.map((condition) => condition.conditionKey);
    return template !== undefined && finding.status === 'missing' && keys.length > 0 && keys.every((key) => (template.keys as readonly string[]).includes(key))
      ? [{ findingId: finding.findingId, templateId: template.templateId, recipientRole: template.recipientRole }] : [];
  });
  return { reads, facts: reads.filter(linked).flatMap(exactCandidates), requests, prefix: [] };
}

export function planTurns(plan: Plan): Turn[] {
  const batches: Candidate[][] = [];
  for (let index = 0; index < plan.facts.length; index += 10) batches.push(plan.facts.slice(index, index + 10));
  return [
    call('list_documents'),
    call('get_policy_pack'),
    ...plan.reads.map((doc) => call('read_document', { documentId: doc.metadata.documentId, version: doc.metadata.version })),
    ...plan.prefix,
    ...batches.map((candidates) => call('propose_facts', { candidates })),
    ...plan.requests.map((candidate) => call('propose_document_request', { candidate })),
    { type: 'finish' },
  ];
}

export interface Fake { name: string; description: string; limits: AgentLimits; turns: (snapshot: CaseSnapshot) => Turn[] }

/** The complete plan with one case's plan changed. */
const perturb = (caseId: string, change: (plan: Plan, snapshot: CaseSnapshot) => Plan) => (snapshot: CaseSnapshot) => {
  const plan = completePlan(snapshot);
  return planTurns(snapshot.caseId === caseId ? change(plan, snapshot) : plan);
};
const editFact = (plan: Plan, field: EvidenceField, edit: (fact: Candidate) => Candidate): Plan => ({ ...plan, facts: plan.facts.map((fact) => (fact.field === field ? edit(fact) : fact)) });

export const FAKES: readonly Fake[] = [
  { name: 'complete_reader', description: 'Scripted complete reader (positive control)', limits: FAKE_LIMITS, turns: (snapshot) => planTurns(completePlan(snapshot)) },
  { name: 'complete_reader_run_plan_limits', description: 'Complete reader under the run-plan six-turn, ten-tool limits', limits: RUN_PLAN_LIMITS, turns: (snapshot) => planTurns(completePlan(snapshot)) },
  { name: 'empty_output', description: 'Finishes at once with no tool call', limits: FAKE_LIMITS, turns: () => [{ type: 'finish' }] },
  {
    name: 'omitted_fact', description: 'CR01 omits supplier.effective_to', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan) => ({ ...plan, facts: plan.facts.filter((fact) => fact.field !== 'supplier.effective_to') })),
  },
  {
    name: 'wrong_typed_value', description: 'CR01 receipt.order_document_version as the string "1"', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan) => editFact(plan, 'receipt.order_document_version', (fact) => (fact.documentId === 'cr01-z-capture' ? { ...fact, value: '1' } : fact))),
  },
  {
    name: 'wrong_locator', description: 'CR02 supplier.status cited at /supplierId', limits: FAKE_LIMITS,
    turns: perturb('CR02', (plan) => editFact(plan, 'supplier.status', (fact) => ({ ...fact, locator: '/supplierId' }))),
  },
  {
    name: 'wrong_hash', description: 'CR03 supplier.status cites another document\'s hash', limits: FAKE_LIMITS,
    turns: perturb('CR03', (plan, snapshot) => {
      const other = snapshot.documents.find((doc) => doc.metadata.kind !== 'supplier_status' && doc.metadata.contentHash !== null)!.metadata.contentHash!;
      return editFact(plan, 'supplier.status', (fact) => ({ ...fact, sourceContentHash: other }));
    }),
  },
  {
    name: 'low_confidence', description: 'CR02 proposes every exact fact at confidence 0.5', limits: FAKE_LIMITS,
    turns: perturb('CR02', (plan) => ({ ...plan, facts: plan.facts.map((fact) => ({ ...fact, confidence: 0.5 })) })),
  },
  {
    name: 'intake_value_then_corrected', description: 'CR04 first proposes supplier.status non_exempt (the intake value), then the exact source value', limits: FAKE_LIMITS,
    turns: perturb('CR04', (plan) => {
      const exact = plan.facts.find((fact) => fact.field === 'supplier.status')!;
      return { ...plan, prefix: [call('propose_facts', { candidates: [{ ...exact, value: 'non_exempt', originalText: 'non_exempt' }] })] };
    }),
  },
  { name: 'malformed_turn', description: 'First turn is not a valid provider turn', limits: FAKE_LIMITS, turns: () => [{ type: 'call_tool' }] },
  { name: 'refusal_or_provider_error', description: 'Provider rejects the first turn', limits: FAKE_LIMITS, turns: () => [FAIL] },
  { name: 'truncated_output', description: 'First turn exceeds the output byte limit', limits: FAKE_LIMITS, turns: () => [call('list_documents', { padding: 'x'.repeat(70 * 1024) })] },
  {
    name: 'malformed_fact_batch', description: 'CR01 sends a propose_facts batch without a candidate array, then the complete plan', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan) => ({ ...plan, prefix: [call('propose_facts', { candidates: 'not-an-array' })] })),
  },
  {
    name: 'oversized_fact_batch', description: 'CR01 sends eleven exact candidates in one propose_facts call (limit ten), then the complete plan', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan) => ({ ...plan, prefix: [call('propose_facts', { candidates: plan.facts.slice(0, 11) })] })),
  },
  {
    name: 'confidence_only_repeats', description: 'CR03 repeats exact supplier.status at confidence 0.91 to 0.98 after the complete plan', limits: FAKE_LIMITS,
    turns: perturb('CR03', (plan) => {
      const exact = plan.facts.find((fact) => fact.field === 'supplier.status')!;
      return { ...plan, facts: [...plan.facts, ...[0.91, 0.92, 0.93, 0.94, 0.95, 0.96, 0.97, 0.98].map((confidence) => ({ ...exact, confidence }))] };
    }),
  },
  {
    name: 'distractor_receipt_as_order', description: 'CR01 cites the unlinked receipt cr01-a-capture as a receipt of f01-order', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan, snapshot) => {
      const distractor = snapshot.documents.find((doc) => doc.metadata.documentId === 'cr01-a-capture')!;
      const linked = exactCandidates(distractor).find((fact) => fact.field === 'receipt.order_document_id')!;
      return { ...plan, facts: [...plan.facts, { ...linked, value: 'f01-order', originalText: 'f01-order' }] };
    }),
  },
  {
    name: 'inapplicable_requests', description: 'CR03 also requests existing_encounter for R04 and existing_receipt for R05', limits: FAKE_LIMITS,
    turns: perturb('CR03', (plan, snapshot) => {
      const extra = (['R04', 'R05'] as const).flatMap((ruleId) => {
        const finding = snapshot.outcome.findings.find((item) => item.ruleId === ruleId && item.status === 'missing');
        const template = TEMPLATE_FOR_RULE[ruleId];
        return finding === undefined ? [] : [{ findingId: finding.findingId, templateId: template.templateId, recipientRole: template.recipientRole }];
      });
      return { ...plan, requests: [...plan.requests, ...extra] };
    }),
  },
  { name: 'omitted_request', description: 'CR03 proposes facts but no request', limits: FAKE_LIMITS, turns: perturb('CR03', (plan) => ({ ...plan, requests: [] })) },
  {
    name: 'unread_exact_facts', description: 'CR01 proposes exact receipt facts without reading any receipt', limits: FAKE_LIMITS,
    turns: perturb('CR01', (plan) => ({ ...plan, reads: plan.reads.filter((doc) => doc.metadata.kind !== 'order_receipt') })),
  },
  {
    name: 'inaccessible_source_fact', description: 'CR02 proposes a receipt timestamp from the restricted receipt', limits: FAKE_LIMITS,
    turns: perturb('CR02', (plan, snapshot) => {
      const restricted = snapshot.documents.find((doc) => doc.metadata.kind === 'order_receipt')!;
      const invented: Candidate = {
        field: 'receipt.received_at', documentId: restricted.metadata.documentId, documentVersion: restricted.metadata.version, locator: '/receivedAt',
        value: '2026-09-05T18:40:00Z', originalText: '2026-09-05T18:40:00Z', confidence: 0.9, sourceContentHash: '0'.repeat(64),
      };
      return { ...plan, facts: [...plan.facts, invented] };
    }),
  },
];

/** An evaluator-only provider replaying a fixed script; past its end it finishes. */
export function scriptedProvider(name: string, turns: readonly Turn[]): AgentProvider {
  return {
    identity: { provider: 'recorded', model: `evaluator-fake-${name}`, label: 'scripted_fixture', recordingSha256: null },
    version: `evaluator:contribution-fake.${name}.v1`,
    next: ({ turn }) => (turns[turn] === FAIL ? Promise.reject(new Error('fake provider failure')) : Promise.resolve(turns[turn] ?? { type: 'finish' })),
  };
}
