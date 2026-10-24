import {
  type AssessedState,
  type AssessmentResultV3,
  compareConditions,
  compareDocumentRefs,
  type DocumentRef,
  type EvidenceFactV2,
  type FindingCondition,
  type FindingStatus,
  type FindingV3,
  type PolicyRuleV2,
  RuleId,
  type StateEffect,
} from '@pa/contracts';

import { type HeldConditionsByRule, type HeldConditionV2, type RuleSelections } from './backstop.js';
import { CANDIDATE_KEYS, documentsRead } from './evaluate.js';
import { refKey } from './lineage.js';
import { type PreflightSnapshot } from './preflight.js';

// Result assembly (C05, C07, D2). Facts come from current usable versions
// only, exactly as written. Each finding takes the outcome the backstop
// selected, cites every fact of its rule's evidence fields from the documents
// the rule reads, names its C07 parent documents and lists every held
// condition in canonical order. A duplicate condition identity is kept so that
// final validation rejects it; nothing is silently removed.

/** SPEC precedence: scope hold, then human review, then missing information; `none` leaves the case ready. */
export const STATE_EFFECT_RANK_V2: Readonly<Record<StateEffect, number>> = { none: 0, needs_information: 1, needs_human_review: 2, scope_hold: 3 };

export const STATE_FOR_EFFECT_V2: Readonly<Record<StateEffect, AssessedState>> = {
  none: 'ready_for_review',
  needs_information: 'needs_information',
  needs_human_review: 'needs_human_review',
  scope_hold: 'scope_hold',
};

/** Every non-null value of every current usable version, in canonical document order, as a proposed deterministic fact. */
export function factsOf(snapshot: PreflightSnapshot): EvidenceFactV2[] {
  const facts: EvidenceFactV2[] = [];
  for (const version of snapshot.versions) {
    const { classification } = version;
    if (!version.current || classification.status !== 'usable' || classification.content === null) {
      continue;
    }
    for (const value of classification.content.values) {
      facts.push({
        schemaVersion: 'pa.evidence-fact.v2',
        factId: `fact-${String(facts.length + 1).padStart(4, '0')}`,
        field: value.field,
        value: value.value,
        documentId: version.ref.documentId,
        documentVersion: version.ref.version,
        locator: value.locator,
        originalText: value.originalText,
        extractionMethod: 'deterministic',
        confidence: null,
        // A pure assessment proposes facts; only a human review can accept or reject them.
        reviewStatus: 'proposed',
      });
    }
  }
  return facts;
}

/** The facts a finding cites (C05): its rule's evidence fields, from the documents the rule reads. */
export function citedFactIds(rule: PolicyRuleV2, facts: readonly EvidenceFactV2[], snapshot: PreflightSnapshot): string[] {
  const read = documentsRead(rule.ruleId, snapshot);
  return facts.filter((fact) => rule.evidenceFields.includes(fact.field) && read.has(refKey({ documentId: fact.documentId, version: fact.documentVersion }))).map((fact) => fact.factId);
}

const uniqueSorted = (refs: readonly DocumentRef[]) => [...new Map(refs.map((ref) => [refKey(ref), { documentId: ref.documentId, version: ref.version }])).values()].sort(compareDocumentRefs);

/** A condition's own routing status, from the pack outcome that declares its key. */
export const declaredStatus = (rule: PolicyRuleV2, conditionKey: string): FindingStatus | undefined =>
  rule.outcomes.find((outcome) => outcome.conditions.some((declaration) => declaration.conditionKey === conditionKey))?.status;

/**
 * The finding's own document references (C07 as amended): R02 names every
 * quarantined version, R09 every version with an R09 condition, and R01, R03,
 * R04 and R05 the documents of their restricted, unreadable and
 * failed-provenance conditions whose status is the finding's status. Any other
 * finding names none.
 */
export function parentRefs(rule: PolicyRuleV2, status: FindingStatus, conditions: readonly FindingCondition[], snapshot: PreflightSnapshot): DocumentRef[] {
  switch (rule.ruleId) {
    case 'R02':
      return uniqueSorted(snapshot.quarantinedDocuments);
    case 'R09':
      return uniqueSorted(conditions.flatMap((condition) => condition.documentRefs));
    case 'R01':
    case 'R03':
    case 'R04':
    case 'R05':
      return uniqueSorted(
        conditions.filter((condition) => CANDIDATE_KEYS.has(condition.conditionKey) && declaredStatus(rule, condition.conditionKey) === status).flatMap((condition) => condition.documentRefs),
      );
    default:
      return [];
  }
}

/**
 * The explanation: the rule title, the selected status, the pack text of every
 * outcome owning a held condition (the pass text for a pass) and each held
 * condition key and field. It is built from reviewed pack text and condition
 * vocabulary only, so no source text, metadata or document identity enters it.
 */
export function explanationOf(rule: PolicyRuleV2, status: FindingStatus, conditions: readonly FindingCondition[]): string {
  const owning = rule.outcomes.filter((outcome) =>
    conditions.length === 0 ? outcome.status === status : outcome.conditions.some((declaration) => conditions.some((condition) => condition.conditionKey === declaration.conditionKey)),
  );
  const named = [...new Set(conditions.map((condition) => (condition.field === null ? condition.conditionKey : `${condition.conditionKey} (${condition.field})`)))];
  const listed = named.length === 0 ? '' : ` Held conditions: ${named.join(', ')}.`;
  return `${rule.title} (${status}): ${owning.map((outcome) => outcome.condition).join(' ')}${listed}`;
}

const conditionOf = (held: HeldConditionV2): FindingCondition => ({
  conditionKey: held.conditionKey,
  field: held.field,
  documentRefs: uniqueSorted(held.documents.map((document) => document.ref)),
});

/** The complete result for a snapshot whose held conditions the backstop found representable. */
export function assembleResultV3(snapshot: PreflightSnapshot, selections: RuleSelections, held: HeldConditionsByRule, policyPackSha256: string): AssessmentResultV3 {
  const { caseRecord, pack } = snapshot;
  const evidenceFacts = factsOf(snapshot);
  let highest: StateEffect = 'none';
  const findings = RuleId.options.map((ruleId): FindingV3 => {
    const rule = pack.rules.find((candidate) => candidate.ruleId === ruleId);
    const outcome = selections[ruleId];
    if (rule === undefined) {
      // Preflight already rejected a pack without every rule.
      throw new Error('the version 2 assessment reached assembly without a complete pack');
    }
    if (STATE_EFFECT_RANK_V2[outcome.stateEffect] > STATE_EFFECT_RANK_V2[highest]) {
      highest = outcome.stateEffect;
    }
    const conditions = held[ruleId].map(conditionOf).sort(compareConditions);
    return {
      schemaVersion: 'pa.finding.v3',
      findingId: `finding-${ruleId}`,
      ruleId,
      status: outcome.status,
      severity: rule.severity,
      evidenceFactIds: citedFactIds(rule, evidenceFacts, snapshot),
      documentRefs: parentRefs(rule, outcome.status, conditions, snapshot),
      conditions,
      explanation: explanationOf(rule, outcome.status, conditions),
      responsibleRole: outcome.responsibleRole,
      caseRevision: caseRecord.revision,
    };
  });
  return {
    schemaVersion: 'pa.assessment-result.v3',
    caseId: caseRecord.caseId,
    caseRevision: caseRecord.revision,
    policyPackId: pack.packId,
    policyPackSha256,
    state: STATE_FOR_EFFECT_V2[highest],
    findings,
    quarantinedDocuments: uniqueSorted(snapshot.quarantinedDocuments),
    supersededDocuments: uniqueSorted(snapshot.supersededDocuments),
    evidenceFacts,
  };
}
