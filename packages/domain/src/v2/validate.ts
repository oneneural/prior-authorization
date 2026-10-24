import {
  arityAllows,
  AssessmentOutcomeV3,
  type AssessmentResultV3,
  conditionIdentity,
  EVIDENCE_FIELD_SOURCES,
  fieldMatchesQualifier,
  type FindingV3,
  type PolicyRuleV2,
  RuleId,
  type StateEffect,
} from '@pa/contracts';

import { citedFactIds, declaredStatus, explanationOf, parentRefs, STATE_EFFECT_RANK_V2, STATE_FOR_EFFECT_V2 } from './assemble.js';
import { type ClassifiedVersion } from './classify.js';
import { CANDIDATE_KEYS, candidateKey } from './evaluate.js';
import { EVALUATOR_INVENTORY_V2 } from './inventory.js';
import { refKey } from './lineage.js';
import { type PreflightSnapshot } from './preflight.js';

// Final validation of an assembled result, before anything is
// exposed: the frozen v3 schemas, then the semantic invariants the schemas
// cannot see. A failure is an internal invariant violation, never an
// input property, so the caller throws a content-free error. The issues below
// are internal diagnostics for tests; none names a value, identifier or path.

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Candidate rule prefixes, for checking that a candidate condition names a version of the class it states. */
const CANDIDATE_PREFIX = /^(R0[1345]\.[a-z_]+?)_(failed_provenance|restricted|unreadable)$/;

function conditionIssues(finding: FindingV3, rule: PolicyRuleV2, versions: ReadonlyMap<string, ClassifiedVersion>): string[] {
  const issues: string[] = [];
  const identities = finding.conditions.map(conditionIdentity);
  if (new Set(identities).size !== identities.length) {
    issues.push('duplicate condition identity');
  }
  for (const condition of finding.conditions) {
    const outcome = rule.outcomes.find((candidate) => candidate.conditions.some((declaration) => declaration.conditionKey === condition.conditionKey));
    const declaration = outcome?.conditions.find((candidate) => candidate.conditionKey === condition.conditionKey);
    if (outcome === undefined || declaration === undefined) {
      issues.push('undeclared condition');
      continue;
    }
    if (!EVALUATOR_INVENTORY_V2[rule.ruleId].conditions.some((entry) => entry.conditionKey === condition.conditionKey && entry.status === outcome.status)) {
      issues.push('condition outside the evaluator inventory');
    }
    if (!fieldMatchesQualifier(declaration.qualifier, condition.field) || (condition.field !== null && !declaration.fields.includes(condition.field))) {
      issues.push('condition field outside its declaration');
    }
    if (!arityAllows(declaration.documentArity, condition.documentRefs.length)) {
      issues.push('condition arity outside its declaration');
    }
    for (const ref of condition.documentRefs) {
      const version = versions.get(refKey(ref));
      if (version === undefined) {
        issues.push('dangling condition reference');
        continue;
      }
      if (!declaration.documentKinds.includes(version.metadata.kind)) {
        issues.push('condition names a document of an undeclared kind');
      }
      issues.push(...referencePermission(rule.ruleId, condition.conditionKey, condition.field, version));
    }
  }
  return issues;
}

/** Whether a condition may name this version: R02 its exact bases, R09 its exact class, candidates their class, any other a current usable version. */
function referencePermission(ruleId: RuleId, conditionKey: string, field: string | null, version: ClassifiedVersion): string[] {
  const { classification } = version;
  if (ruleId === 'R02') {
    return classification.status === 'quarantined' && field !== null && (classification.bases as readonly string[]).includes(field) ? [] : ['R02 condition names a version not quarantined on that basis'];
  }
  if (ruleId === 'R09') {
    return classification.status === 'r09' && classification.conditionKey === conditionKey ? [] : ['R09 condition names a version without that condition'];
  }
  if (!version.current) {
    return ['condition names a superseded version'];
  }
  if (CANDIDATE_KEYS.has(conditionKey)) {
    const prefix = CANDIDATE_PREFIX.exec(conditionKey)?.[1];
    return prefix !== undefined && candidateKey(prefix, version) === conditionKey ? [] : ['candidate condition names a version of another class'];
  }
  return classification.status === 'usable' ? [] : ['condition names an unusable version'];
}

/** Every invariant the result breaks for this snapshot and the hash of the exact pack bytes; empty when it is valid. */
export function resultIssuesV3(candidate: unknown, snapshot: PreflightSnapshot, policyPackSha256: string): string[] {
  // The frozen schemas reject a duplicate condition identity, an unknown fact
  // ID and fact text inconsistent with its value first; the semantic checks
  // below repeat the identity check as a second layer.
  if (!AssessmentOutcomeV3.safeParse({ schemaVersion: 'pa.assessment-outcome.v3', outcome: 'assessed', result: candidate }).success) {
    return ['result does not match the v3 schemas'];
  }
  const result = candidate as AssessmentResultV3;
  const { caseRecord, pack } = snapshot;
  const issues: string[] = [];
  if (result.caseId !== caseRecord.caseId || result.caseRevision !== caseRecord.revision) {
    issues.push('result names another case or revision');
  }
  if (result.policyPackId !== pack.packId || result.policyPackSha256 !== policyPackSha256) {
    issues.push('result names another pack or pack hash');
  }
  if (!same(result.quarantinedDocuments, snapshot.quarantinedDocuments) || !same(result.supersededDocuments, snapshot.supersededDocuments)) {
    issues.push('quarantine or superseded list differs from the snapshot');
  }
  if (!same(result.findings.map((finding) => finding.ruleId), RuleId.options)) {
    issues.push('findings are not exactly R01 to R10 in order');
  }

  // Facts: each is the exact extracted value of a current usable version at its
  // field's fixed locator, once per version and field, and every such value is a fact.
  const versions = new Map(snapshot.versions.map((version) => [refKey(version.ref), version]));
  const seen = new Set<string>();
  let expected = 0;
  for (const version of snapshot.versions) {
    expected += version.current && version.classification.status === 'usable' ? (version.classification.content?.values.length ?? 0) : 0;
  }
  for (const fact of result.evidenceFacts) {
    const version = versions.get(refKey({ documentId: fact.documentId, version: fact.documentVersion }));
    const content = version?.current === true && version.classification.status === 'usable' ? version.classification.content : null;
    const source = content?.values.find((value) => value.field === fact.field);
    if (version === undefined || source === undefined || EVIDENCE_FIELD_SOURCES[fact.field].documentKind !== version.metadata.kind) {
      issues.push('fact from an ineligible source');
    } else if (source.value !== fact.value || source.originalText !== fact.originalText || source.locator !== fact.locator) {
      issues.push('fact differs from its exact source value');
    }
    if (fact.extractionMethod !== 'deterministic' || fact.confidence !== null || fact.reviewStatus !== 'proposed') {
      issues.push('fact is not a proposed deterministic extraction');
    }
    const key = `${fact.documentId}@v${String(fact.documentVersion)}#${fact.field}`;
    if (seen.has(key)) {
      issues.push('duplicate fact for one version and field');
    }
    seen.add(key);
  }
  if (result.evidenceFacts.length !== expected) {
    issues.push('facts omit a value of a current usable version');
  }

  let highest: StateEffect = 'none';
  for (const finding of result.findings) {
    const rule = pack.rules.find((candidateRule) => candidateRule.ruleId === finding.ruleId);
    if (rule === undefined) {
      issues.push('finding for a rule the pack does not declare');
      continue;
    }
    issues.push(...conditionIssues(finding, rule, versions));
    // The first outcome in the pack's order owning a held condition, or pass.
    const selected =
      finding.conditions.length === 0
        ? rule.outcomes.find((outcome) => outcome.status === 'pass')
        : rule.outcomes.find((outcome) => finding.conditions.some((condition) => declaredStatus(rule, condition.conditionKey) === outcome.status));
    if (selected === undefined || selected.status !== finding.status || selected.responsibleRole !== finding.responsibleRole || rule.severity !== finding.severity) {
      issues.push('finding status, role or severity differs from its selected outcome');
      continue;
    }
    const supported = EVALUATOR_INVENTORY_V2[rule.ruleId].statuses.find((entry) => entry.status === selected.status);
    if (supported === undefined || (supported.responsibleRole ?? selected.responsibleRole) !== selected.responsibleRole || (supported.stateEffect ?? selected.stateEffect) !== selected.stateEffect) {
      issues.push('finding routing differs from the evaluator inventory');
    }
    if (STATE_EFFECT_RANK_V2[selected.stateEffect] > STATE_EFFECT_RANK_V2[highest]) {
      highest = selected.stateEffect;
    }
    if (!same(finding.evidenceFactIds, citedFactIds(rule, result.evidenceFacts, snapshot))) {
      issues.push('citations differ from the eligible facts of the rule');
    }
    if (!same(finding.documentRefs, parentRefs(rule, finding.status, finding.conditions, snapshot))) {
      issues.push('parent references differ from C07');
    }
    if (finding.explanation !== explanationOf(rule, finding.status, finding.conditions)) {
      issues.push('explanation is not built from pack text and condition vocabulary');
    }
    if (finding.findingId !== `finding-${finding.ruleId}` || finding.caseRevision !== caseRecord.revision) {
      issues.push('finding identity differs');
    }
  }
  if (result.state !== STATE_FOR_EFFECT_V2[highest]) {
    issues.push('state is not the highest selected state effect');
  }
  return issues;
}
