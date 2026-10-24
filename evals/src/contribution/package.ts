import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

import { EvidenceField, RecipientRole, RequestTemplate, RuleId } from '@pa/contracts';

import { REPO_ROOT } from '../v2/files.js';

// The imported regression contribution package (version 2). Case
// bytes live in the suite root under `fixtures/` so the v2 loader reads them;
// the frozen gold, scoring contract, run plan, template and README live under
// evals/expectations/contribution. Runtime and prompt code never read either.

export const CONTRIBUTION_SUITE_ROOT = 'evals/suites/contribution';
export const CONTRIBUTION_EXPECTATIONS_DIR = 'evals/expectations/contribution';

/** Every file the package's SHA256SUMS lists, mapped to where this repository keeps it. */
export function importedPath(listed: string, repoRoot = REPO_ROOT): string {
  return listed.startsWith('cases/')
    ? join(repoRoot, CONTRIBUTION_SUITE_ROOT, 'fixtures', listed.slice('cases/'.length))
    : join(repoRoot, CONTRIBUTION_EXPECTATIONS_DIR, listed);
}

/** Package files the source package omits: a Python static validator and the authoring read inventory. */
export const NOT_IMPORTED = ['source-inventory.json', 'validate_artifacts.py'] as const;

/** The SHA256SUMS digest of the imported v2 package. */
export const PACKAGE_SUMS_SHA256 = 'eb0a196941738bf166d23ffb39b307af7d501456d7758ca6fe3b9720410e61cc';
export const SCORING_CONTRACT_SHA256 = '8c61814d8bf724757847e3dce6e1f09a0d6ca30b23fa9074e82262925f277fd7';
export const EXPECTATIONS_SHA256 = '3dd93ef3fc28597ab32df9b3b1dfe98e6409d65afdcc99987796bca3b904a0c7';

export const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

export interface SumsCheck { verified: string[]; mismatched: string[]; notImported: string[]; missing: string[]; sumsSha256: string }

/** Checks every SHA256SUMS line against the imported bytes. Only the two named exclusions may be absent. */
export async function verifyPackage(repoRoot = REPO_ROOT): Promise<SumsCheck> {
  const sums = await readFile(join(repoRoot, CONTRIBUTION_EXPECTATIONS_DIR, 'SHA256SUMS'));
  const result: SumsCheck = { verified: [], mismatched: [], notImported: [], missing: [], sumsSha256: sha256(sums) };
  for (const line of sums.toString('utf8').split('\n').filter((item) => item !== '')) {
    const match = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (match === null) {
      result.mismatched.push(`unparsable line: ${line.slice(0, 40)}`);
      continue;
    }
    const [, digest, listed] = match as unknown as [string, string, string];
    let bytes: Buffer;
    try {
      bytes = await readFile(importedPath(listed, repoRoot));
    } catch {
      ((NOT_IMPORTED as readonly string[]).includes(listed) ? result.notImported : result.missing).push(listed);
      continue;
    }
    (sha256(bytes) === digest ? result.verified : result.mismatched).push(listed);
  }
  return result;
}

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const Bounds = z.strictObject({ minimum: z.number(), maximum: z.number() });
const DocRef = z.strictObject({ documentId: z.string().min(1), version: z.int().positive() });
const ConditionTuple = z.strictObject({ conditionKey: z.string().regex(/^R[0-9]{2}\.[a-z_]+$/), field: EvidenceField.nullable(), documents: z.array(DocRef) });
const Denominators = z.strictObject({ requiredFacts: z.int().nonnegative(), usefulRequests: z.int().nonnegative(), abstentionOpportunities: z.int().nonnegative(), blockedCases: z.int().nonnegative() });

export const RequiredFact = z.strictObject({
  targetId: z.string().min(1),
  field: EvidenceField,
  documentId: z.string().min(1),
  documentVersion: z.int().positive(),
  sourceContentHash: Sha256Hex,
  locator: z.string().startsWith('/'),
  value: z.union([z.string(), z.number(), z.boolean()]),
  originalText: z.string(),
  confidence: Bounds,
  gateExpectation: z.literal('valid_if_current_binding_and_active_job'),
  requiresSuccessfulRead: z.literal(true),
});
export type RequiredFact = z.infer<typeof RequiredFact>;

export const UsefulRequest = z.strictObject({
  targetId: z.string().min(1),
  findingSelector: z.strictObject({ ruleId: RuleId, status: z.literal('missing'), conditionKeysExactSet: z.array(z.string().min(1)).min(1), findingId: z.string().min(1) }),
  templateId: RequestTemplate,
  recipientRole: RecipientRole,
  bodyPolicy: z.string().min(1),
  gateExpectation: z.literal('valid_if_current_binding_and_active_job'),
});
export type UsefulRequest = z.infer<typeof UsefulRequest>;

export const Abstention = z.strictObject({
  targetId: z.string().min(1),
  scope: z.string().min(1),
  rationale: z.string().min(1),
  positiveWorkRequired: z.union([z.strictObject({ atLeastRequiredFacts: z.int().positive() }), z.strictObject({ requiredFactTargetIds: z.array(z.string().min(1)).min(1) })]),
  requiredStop: z.literal('finished'),
  forbidInferenceFromAbsence: z.literal(true),
});
export type Abstention = z.infer<typeof Abstention>;

const RULE_IDS = ['R01', 'R02', 'R03', 'R04', 'R05', 'R06', 'R07', 'R08', 'R09', 'R10'] as const;
const Status = z.enum(['pass', 'missing', 'conflict', 'unreadable', 'restricted', 'manual_review', 'not_applicable']);

export const ContributionCase = z.strictObject({
  caseId: z.string().regex(/^CR[0-9]{2}$/),
  split: z.literal('regression'),
  mechanism: z.string().min(1),
  fixturePath: z.string().min(1),
  fixtureManifestSha256: Sha256Hex,
  evaluatorAuthoredSynthetic: z.literal(true),
  sharedLineage: z.string().min(1),
  requiredSupportedFacts: z.array(RequiredFact),
  usefulNeutralRequests: z.array(UsefulRequest),
  correctAbstentions: z.array(Abstention),
  forbiddenOutputs: z.array(z.string().min(1)),
  issueReadinessSafety: z.strictObject({
    expectedState: z.string().min(1),
    clinicalReviewRequired: z.literal(true),
    ruleStatuses: z.strictObject(Object.fromEntries(RULE_IDS.map((id) => [id, Status])) as Record<(typeof RULE_IDS)[number], typeof Status>),
    conditionTuplesExactSet: z.partialRecord(RuleId, z.array(ConditionTuple)),
    quarantinedDocuments: z.array(DocRef),
    supersededDocuments: z.array(DocRef),
    prohibitedExecuted: z.literal(0),
  }),
  denominators: Denominators,
  inapplicableRequests: z.array(z.string().min(1)),
  forbiddenOutputScoring: z.strictObject({ safetyProhibitedIndices: z.array(z.int().nonnegative()), diagnosticOnlyIndices: z.array(z.int().nonnegative()), indexBase: z.literal(0) }),
});
export type ContributionCase = z.infer<typeof ContributionCase>;

/** `pa.contribution-expectations.v2`: the evaluator-owned regression gold, parsed strictly. */
export const ContributionExpectations = z.strictObject({
  packageId: z.literal('contribution-regression'),
  author: z.string().min(1),
  authoredOn: z.string().min(1),
  specSha256: Sha256Hex,
  policyInput: z.strictObject({ packId: z.string().min(1), path: z.string().min(1), sha256: Sha256Hex }),
  formatNote: z.string().min(1),
  schemaVersion: z.literal('pa.contribution-expectations.v2'),
  status: z.string().min(1),
  refrozenOn: z.string().min(1),
  split: z.literal('regression'),
  scoringContract: z.strictObject({ path: z.literal('scoring-contract.json'), sha256: Sha256Hex }),
  cohortDenominators: Denominators,
  cases: z.array(ContributionCase).min(1),
});
export type ContributionExpectations = z.infer<typeof ContributionExpectations>;

const Metric = z.object({ numerator: z.string().min(1), denominator: z.string().min(1) });

/**
 * `pa.contribution-scoring.v2`, parsed for the keys this scorer implements. The
 * prose semantics are pinned by hash; the match keys must be exactly the ones
 * the scorer compares.
 */
export const ScoringContract = z.object({
  schemaVersion: z.literal('pa.contribution-scoring.v2'),
  packageId: z.literal('contribution-regression'),
  predictionContract: z.object({
    requiredFactMatchKey: z.tuple([z.literal('field'), z.literal('documentId'), z.literal('documentVersion'), z.literal('sourceContentHash'), z.literal('locator'), z.literal('typed_value'), z.literal('originalText')]),
    requestMatchKey: z.tuple([z.literal('caseId'), z.literal('current_finding_rule'), z.literal('current_finding_status'), z.literal('conditionKeysExactSet'), z.literal('templateId'), z.literal('recipientRole')]),
    inapplicableRequests: z.string().min(1),
  }),
  scoring: z.object({
    zeroDenominator: z.string().min(1),
    requiredFactRetrievalRecall: Metric,
    supportedExtractionPrecision: Metric,
    currentRelevantExtractionPrecision: Metric,
    usefulRequestPrecision: Metric,
    usefulRequestRecall: Metric,
    omissions: Metric,
    corrections: Metric,
    abstentionCorrectness: Metric,
    contribution: z.object({ primary: z.string().min(1) }),
    safety: z.object({
      separate: z.literal(true), issuePrecision: z.string(), issueRecall: z.string(), falseReady: z.string(), conditions: z.string(), prohibited: z.string(),
      issuePrecisionExcludingR06: z.string(), issueRecallExcludingR06: z.string(),
    }),
    specDefinedExtractionPrecision: Metric,
    observability: z.object({ flag: z.literal('port_unobservable_supersession') }),
  }),
  globalForbiddenOutputs: z.array(z.string().min(1)).length(6),
});
export type ScoringContract = z.infer<typeof ScoringContract>;

export interface ContributionPackage { expectations: ContributionExpectations; contract: ScoringContract; expectationsSha256: string; contractSha256: string }

/** Loads and checks the frozen gold: pinned hashes, strict schema and per-case denominators that sum to the cohort. */
export async function loadContributionPackage(repoRoot = REPO_ROOT): Promise<ContributionPackage> {
  const dir = join(repoRoot, CONTRIBUTION_EXPECTATIONS_DIR);
  const expectationsBytes = await readFile(join(dir, 'expectations.json'));
  const contractBytes = await readFile(join(dir, 'scoring-contract.json'));
  const expectations = ContributionExpectations.parse(JSON.parse(expectationsBytes.toString('utf8')));
  const contract = ScoringContract.parse(JSON.parse(contractBytes.toString('utf8')));
  const problems: string[] = [];
  if (sha256(expectationsBytes) !== EXPECTATIONS_SHA256) problems.push('expectations.json differs from its pinned hash');
  if (sha256(contractBytes) !== SCORING_CONTRACT_SHA256 || expectations.scoringContract.sha256 !== SCORING_CONTRACT_SHA256) problems.push('scoring-contract.json differs from its pinned hash');
  const total = { requiredFacts: 0, usefulRequests: 0, abstentionOpportunities: 0, blockedCases: 0 };
  for (const item of expectations.cases) {
    const own = { requiredFacts: item.requiredSupportedFacts.length, usefulRequests: item.usefulNeutralRequests.length, abstentionOpportunities: item.correctAbstentions.length };
    for (const [key, value] of Object.entries(own) as [keyof typeof own, number][]) {
      if (item.denominators[key] !== value) problems.push(`${item.caseId}: ${key} denominator ${item.denominators[key]} differs from ${value} listed targets`);
    }
    for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] += item.denominators[key];
  }
  for (const key of Object.keys(total) as (keyof typeof total)[]) {
    if (total[key] !== expectations.cohortDenominators[key]) problems.push(`cohort ${key}: cases sum to ${total[key]}, cohort says ${expectations.cohortDenominators[key]}`);
  }
  if (problems.length > 0) throw new Error(`contribution package invalid:\n- ${problems.join('\n- ')}`);
  return { expectations, contract, expectationsSha256: sha256(expectationsBytes), contractSha256: sha256(contractBytes) };
}
