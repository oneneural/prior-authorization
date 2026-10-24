import {
  type AssessedState,
  AssessmentResult,
  Case,
  Document,
  type DocumentRef,
  type EvidenceFact,
  type Finding,
  IsoDate,
  PolicyPack,
  type PolicyRule,
  RuleId,
  type RuleOutcome,
  type StateEffect,
} from '@pa/contracts';

import { assessDocuments, isQuarantined, type SourceInput } from './documents.js';
import { type Sha256Hasher, webCryptoSha256 } from './hash.js';
import { EVALUATOR_STATUSES, type HeldCondition, RULE_EVALUATORS, type RuleContext } from './rules.js';

export interface AssessmentInput {
  /** A contract-valid case; it is validated again here (schema rejection). */
  caseRecord: Case;
  /** Every document version supplied with the case, with its exact source bytes. */
  documents: readonly SourceInput[];
  /** The exact policy pack bytes; the pack is parsed from them and `policyPackSha256` hashes them. */
  policyPackBytes: Uint8Array;
  /** The explicit scenario date; there is no clock. It must equal the case assessment date. */
  assessmentDate: string;
}

export interface AssessmentOptions {
  /** SHA-256 implementation; the Web Crypto global by default. */
  sha256?: Sha256Hasher;
}

/** Schema rejection comes before every state (SPEC precedence); it is not an assessed state. */
export type AssessmentOutcome = { outcome: 'rejected'; issues: string[] } | { outcome: 'assessed'; result: AssessmentResult };

/** SPEC precedence: scope hold, then human review, then missing information; `none` leaves the case ready. */
export const STATE_EFFECT_RANK: Readonly<Record<StateEffect, number>> = { none: 0, needs_information: 1, needs_human_review: 2, scope_hold: 3 };

const STATE_FOR_EFFECT: Readonly<Record<StateEffect, AssessedState>> = {
  none: 'ready_for_review',
  needs_information: 'needs_information',
  needs_human_review: 'needs_human_review',
  scope_hold: 'scope_hold',
};

/** Statuses whose finding never names a document (pack convention C07). */
const NAMES_NO_DOCUMENT = new Set(['pass', 'missing', 'not_applicable']);

const utf8 = new TextDecoder('utf-8', { fatal: true });

const describeIssues = (prefix: string, error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${prefix}${issue.path.length > 0 ? `.${issue.path.map(String).join('.')}` : ''}: ${issue.message}`);

function parsePack(bytes: Uint8Array): { pack: PolicyPack } | { issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(utf8.decode(bytes));
  } catch {
    return { issues: ['policy pack: bytes are not valid UTF-8 JSON'] };
  }
  const parsed = PolicyPack.safeParse(json);
  if (!parsed.success) {
    return { issues: describeIssues('policy pack', parsed.error) };
  }
  const implemented = [...RuleId.options].sort();
  const defined = parsed.data.rules.map((rule) => rule.ruleId).sort();
  if (JSON.stringify(defined) !== JSON.stringify(implemented)) {
    return { issues: [`policy pack: defines rules [${defined.join(', ')}], the assessment implements [${implemented.join(', ')}]`] };
  }
  const uncovered = parsed.data.rules.flatMap((rule) => {
    const absent = EVALUATOR_STATUSES[rule.ruleId].filter((status) => !rule.outcomes.some((outcome) => outcome.status === status));
    return absent.length === 0 ? [] : [`policy pack: ${rule.ruleId} has no outcome for ${absent.join(', ')}, which the assessment can report`];
  });
  if (uncovered.length > 0) {
    return { issues: uncovered };
  }
  return { pack: parsed.data };
}

function validateInput(input: AssessmentInput): { caseRecord: Case; pack: PolicyPack; subjectName: string } | { issues: string[] } {
  const issues: string[] = [];
  const caseRecord = Case.safeParse(input.caseRecord);
  if (!caseRecord.success) {
    issues.push(...describeIssues('case', caseRecord.error));
  }
  const date = IsoDate.safeParse(input.assessmentDate);
  if (!date.success) {
    issues.push('assessmentDate: must be an ISO calendar date');
  } else if (caseRecord.success && date.data !== caseRecord.data.assessmentDate) {
    issues.push(`assessmentDate: ${date.data} differs from the case assessment date ${caseRecord.data.assessmentDate}`);
  }
  const seen = new Set<string>();
  input.documents.forEach(({ meta, bytes }, index) => {
    const parsed = Document.safeParse(meta);
    if (!parsed.success) {
      issues.push(...describeIssues(`documents.${index}.meta`, parsed.error));
      return;
    }
    const key = `${parsed.data.documentId}@v${parsed.data.version}`;
    if (seen.has(key)) {
      issues.push(`documents.${index}: ${parsed.data.documentId} v${parsed.data.version} is supplied twice`);
    }
    seen.add(key);
    if ((parsed.data.accessStatus === 'restricted') !== (bytes === null)) {
      issues.push(`documents.${index}: source bytes are held exactly when access is not restricted`);
    }
  });
  const pack = parsePack(input.policyPackBytes);
  if ('issues' in pack) {
    issues.push(...pack.issues);
  }
  if (issues.length > 0 || !caseRecord.success || 'issues' in pack) {
    return { issues };
  }
  // The parsed case trims subjectName; R02 compares the exact strings supplied.
  return { caseRecord: caseRecord.data, pack: pack.pack, subjectName: input.caseRecord.subjectName };
}

/**
 * The first outcome in the pack's order whose status held (C05). Every held
 * status must have an outcome: a condition is never dropped, so a blocker can
 * never become a pass. `parsePack` guarantees this for declared statuses.
 */
export function selectOutcome(rule: PolicyRule, held: readonly HeldCondition[]): RuleOutcome {
  const uncovered = held.filter(
    (condition) => !EVALUATOR_STATUSES[rule.ruleId].includes(condition.status) || !rule.outcomes.some((candidate) => candidate.status === condition.status),
  );
  const outcome = rule.outcomes.find((candidate) => held.some((condition) => condition.status === candidate.status));
  if (uncovered.length > 0 || outcome === undefined) {
    const statuses = [...new Set(uncovered.map((condition) => condition.status))];
    throw new Error(`${rule.ruleId}: no pack outcome or declared status for the held condition statuses [${statuses.join(', ')}]`);
  }
  return outcome;
}

const uniqueRefs = (refs: readonly DocumentRef[]) => [...new Map(refs.map((ref) => [`${ref.documentId}@v${ref.version}`, ref])).values()];

/**
 * Assesses one case revision against one policy pack: R09 provenance checks on
 * every document, then R02 subject binding, then deterministic extraction from
 * usable documents only, then rules R01 to R10 with one finding each, then the
 * case state by SPEC precedence. Pure: no clock, file system, network or
 * environment; the caller supplies every byte and the assessment date.
 */
export async function assess(input: AssessmentInput, options: AssessmentOptions = {}): Promise<AssessmentOutcome> {
  const validated = validateInput(input);
  if ('issues' in validated) {
    return { outcome: 'rejected', issues: validated.issues };
  }
  const { caseRecord, pack, subjectName } = validated;
  const sha256 = options.sha256 ?? webCryptoSha256;
  const documents = await assessDocuments(input.documents, { subjectId: caseRecord.subjectId, subjectName }, pack, sha256);

  // The result lists quarantined documents by ID and rejects every fact from a
  // listed ID, so it cannot hold a quarantined version beside a usable one.
  // Refusing with a stated reason fails closed (an open contract question).
  const quarantinedIds = new Set(documents.filter(isQuarantined).map((document) => document.meta.documentId));
  const mixed = [...new Set(documents.filter((document) => document.usable && quarantinedIds.has(document.meta.documentId)).map((document) => document.meta.documentId))];
  if (mixed.length > 0) {
    return {
      outcome: 'rejected',
      issues: mixed.map(
        (documentId) => `documents: ${documentId} has a quarantined version and a usable version, which an AssessmentResult cannot represent because it quarantines by document ID`,
      ),
    };
  }

  // Facts come only from usable documents: never quarantined, restricted,
  // unreadable or provenance-failed ones.
  const evidenceFacts: EvidenceFact[] = [];
  for (const document of documents) {
    if (!document.usable || document.provenance.status !== 'valid') {
      continue;
    }
    for (const value of document.provenance.values) {
      evidenceFacts.push({
        schemaVersion: 'pa.evidence-fact.v1',
        factId: `fact-${String(evidenceFacts.length + 1).padStart(4, '0')}`,
        field: value.field,
        value: value.value,
        documentId: document.meta.documentId,
        documentVersion: document.meta.version,
        locator: value.locator,
        originalText: value.originalText,
        extractionMethod: 'deterministic',
        confidence: null,
        // A pure assessment proposes facts; only a human review can accept or reject them.
        reviewStatus: 'proposed',
      });
    }
  }

  const context: RuleContext = { caseRecord, pack, assessmentDate: input.assessmentDate, documents };
  let highest: StateEffect = 'none';
  const findings: Finding[] = pack.rules.map((rule) => {
    const evaluation = RULE_EVALUATORS[rule.ruleId](context);
    // One finding per rule: the first outcome in the pack's order whose condition held (C05).
    const outcome = selectOutcome(rule, evaluation.held);
    // The explanation names every condition that held, in the pack's outcome order (C05).
    const rank = (condition: HeldCondition) => rule.outcomes.findIndex((candidate) => candidate.status === condition.status);
    const explained = evaluation.held
      .filter((condition) => condition.status !== 'pass' || outcome.status === 'pass')
      .map((condition, index) => ({ condition, index }))
      .sort((a, b) => rank(a.condition) - rank(b.condition) || a.index - b.index)
      .map(({ condition }) => condition);
    const named = evaluation.held.filter((condition) => evaluation.namesEveryAffectedDocument === true || condition.status === outcome.status);
    if (STATE_EFFECT_RANK[outcome.stateEffect] > STATE_EFFECT_RANK[highest]) {
      highest = outcome.stateEffect;
    }
    return {
      schemaVersion: 'pa.finding.v2',
      findingId: `finding-${rule.ruleId}`,
      ruleId: rule.ruleId,
      status: outcome.status,
      severity: rule.severity,
      evidenceFactIds: evidenceFacts.filter((fact) => rule.evidenceFields.includes(fact.field)).map((fact) => fact.factId),
      documentRefs: NAMES_NO_DOCUMENT.has(outcome.status) ? [] : uniqueRefs(named.flatMap((condition) => condition.documents ?? [])),
      explanation: `${rule.title} (${outcome.status}): ${[...new Set(explained.map((condition) => condition.text))].join('; ')}.`,
      responsibleRole: outcome.responsibleRole,
      caseRevision: caseRecord.revision,
    };
  });

  const result: AssessmentResult = {
    schemaVersion: 'pa.assessment-result.v2',
    caseId: caseRecord.caseId,
    caseRevision: caseRecord.revision,
    policyPackId: pack.packId,
    policyPackSha256: await sha256(input.policyPackBytes),
    state: STATE_FOR_EFFECT[highest],
    findings,
    quarantinedDocumentIds: [...quarantinedIds],
    evidenceFacts,
  };
  const checked = AssessmentResult.safeParse(result);
  if (!checked.success) {
    throw new Error(`assessment produced an invalid result: ${describeIssues('result', checked.error).join('; ')}`);
  }
  // The validated result as built: the parsed copy trims `originalText`, which
  // would no longer be the exact source text (PA-A03).
  return { outcome: 'assessed', result };
}
