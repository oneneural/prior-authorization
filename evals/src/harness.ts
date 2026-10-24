import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type AssessedState, AssessmentResult, EVIDENCE_FIELD_SOURCES, PolicyPack } from '@pa/contracts';
import { assess } from '@pa/domain';

import { checkFixture, FIXTURES_DIR, type LoadedFixture, ORACLES_DIR, POLICY_PACK_PATH, sha256 } from './fixture.js';
import { FROZEN_ORACLES, FROZEN_POLICY_PACK } from './frozen.js';
import { resolvePointer } from './json-pointer.js';
import { Oracle } from './schemas.js';

// Rules-only evaluation harness. It runs the deterministic
// assessment on every frozen first-slice fixture and compares the result with
// its oracle as complete sets. The assessment never sees the oracle: the
// harness loads fixtures and oracles itself and passes only fixture inputs.

export interface FixtureInputs {
  fixtureId: string;
  oracleBytes: Uint8Array;
  packBytes: Uint8Array;
}

export interface FixtureEvaluation {
  fixtureId: string;
  /** `undefined` when the oracle was refused: not frozen, or its bytes differ. */
  expectedState: AssessedState | undefined;
  /** `rejected` when the assessment refused the input; `undefined` when it never ran. */
  actualState: AssessedState | 'rejected' | undefined;
  /** Every reason the comparison failed; empty when the result matches its oracle. */
  problems: string[];
  result: AssessmentResult | undefined;
}

export async function loadFixtureInputs(fixtureId: string): Promise<FixtureInputs> {
  return {
    fixtureId,
    oracleBytes: await readFile(join(ORACLES_DIR, `${fixtureId}.json`)),
    packBytes: await readFile(POLICY_PACK_PATH),
  };
}

/** The oracle and pack bytes must equal the frozen table before anything is compared. */
export function checkFrozen(fixtureId: string, oracleBytes: Uint8Array, packBytes: Uint8Array): string[] {
  const problems: string[] = [];
  const frozen = FROZEN_ORACLES[fixtureId];
  if (frozen === undefined) {
    problems.push(`${fixtureId} has no frozen oracle hash`);
  } else if (sha256(oracleBytes) !== frozen) {
    problems.push(`oracle ${fixtureId} bytes (${sha256(oracleBytes)}) differ from the frozen SHA-256 ${frozen}`);
  }
  if (sha256(packBytes) !== FROZEN_POLICY_PACK.sha256) {
    problems.push(`policy pack bytes (${sha256(packBytes)}) differ from the frozen SHA-256 ${FROZEN_POLICY_PACK.sha256}`);
  }
  return problems;
}

const citationKey = (documentId: string, version: number, locator: string) => `${documentId}@v${version}${locator}`;
const refKey = (ref: { documentId: string; version: number }) => `${ref.documentId}@v${ref.version}`;

// Contract vocabulary (format, kind and record status) is not document content.
const VOCABULARY_KEYS = new Set(['schemaVersion', 'documentKind', 'status']);

function stringLeaves(value: unknown, into: Set<string>): Set<string> {
  if (typeof value === 'string') {
    into.add(value);
  } else if (Array.isArray(value)) {
    value.forEach((item) => stringLeaves(item, into));
  } else if (value !== null && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (!VOCABULARY_KEYS.has(key)) {
        stringLeaves(item, into);
      }
    });
  }
  return into;
}

const parseBytes = (bytes: Uint8Array | null): unknown => {
  if (bytes === null) {
    return undefined;
  }
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
};

/**
 * Checks a result independently of the assessment: the contract parse, every
 * fact against its exact source (an available document version of a supported
 * MIME type, its hash, body kind, locator, value and original text), every
 * finding's fact references, and that nothing from a quarantined document leaks
 * into facts, citations, document references or finding text (R02 may name a
 * quarantined document by ID and version only).
 */
export function validateResult(result: AssessmentResult, fixture: LoadedFixture, oracle: Oracle, pack: PolicyPack): string[] {
  const problems: string[] = [];
  const contract = AssessmentResult.safeParse(result);
  if (!contract.success) {
    problems.push(...contract.error.issues.map((issue) => `contract: ${issue.path.map(String).join('.')}: ${issue.message}`));
  }
  if (result.caseId !== fixture.caseRecord.caseId || result.caseRevision !== fixture.caseRecord.revision) {
    problems.push('result is for another case or revision');
  }
  if (result.policyPackId !== FROZEN_POLICY_PACK.packId || result.policyPackSha256 !== FROZEN_POLICY_PACK.sha256) {
    problems.push(`result names pack ${result.policyPackId} with SHA-256 ${result.policyPackSha256}, not the frozen pack`);
  }

  const quarantined = new Set([...oracle.quarantinedDocumentIds, ...result.quarantinedDocumentIds]);
  for (const fact of result.evidenceFacts) {
    const label = `fact ${fact.factId}`;
    const document = fixture.documents.find((candidate) => candidate.meta.documentId === fact.documentId && candidate.meta.version === fact.documentVersion);
    if (document === undefined) {
      problems.push(`${label} cites ${fact.documentId} v${fact.documentVersion}, which is not in the fixture`);
      continue;
    }
    if (quarantined.has(fact.documentId)) {
      problems.push(`${label} comes from quarantined document ${fact.documentId}`);
    }
    if (document.meta.accessStatus !== 'available') {
      problems.push(`${label} comes from ${fact.documentId} v${fact.documentVersion}, whose access status is ${document.meta.accessStatus}`);
    }
    if (!pack.scope.documentMimeTypes.includes(document.meta.mimeType)) {
      problems.push(`${label} comes from ${fact.documentId} v${fact.documentVersion}, whose MIME type ${document.meta.mimeType} the pack does not support`);
    }
    if (document.raw === null || sha256(document.raw) !== document.meta.contentHash) {
      problems.push(`${label} cites ${fact.documentId} v${fact.documentVersion}, whose bytes do not match its contentHash`);
      continue;
    }
    const body = parseBytes(document.raw);
    const bodyKind = body !== null && typeof body === 'object' && 'documentKind' in body ? body.documentKind : undefined;
    if (bodyKind !== document.meta.kind) {
      problems.push(`${label} comes from ${fact.documentId} v${fact.documentVersion}, whose body kind ${String(bodyKind)} differs from its metadata kind ${document.meta.kind}`);
    }
    const source = EVIDENCE_FIELD_SOURCES[fact.field];
    if (source.documentKind !== document.meta.kind || source.pointer !== fact.locator) {
      problems.push(`${label}: field ${fact.field} is not read from ${fact.locator} in a ${document.meta.kind} document`);
    }
    const resolved = resolvePointer(body, fact.locator);
    if (!resolved.found || resolved.value === null || resolved.value !== fact.value) {
      problems.push(`${label}: ${fact.locator} in ${fact.documentId} v${fact.documentVersion} does not hold the fact's value`);
    }
    let quoted: unknown;
    try {
      quoted = typeof fact.value === 'string' ? fact.originalText : JSON.parse(fact.originalText);
    } catch {
      quoted = undefined;
    }
    if (quoted !== fact.value) {
      problems.push(`${label}: originalText does not state the fact's value`);
    }
    if (fact.extractionMethod !== 'deterministic' || fact.confidence !== null) {
      problems.push(`${label}: a rules-only run reports deterministic extraction without confidence`);
    }
  }

  const factIds = new Set(result.evidenceFacts.map((fact) => fact.factId));
  for (const finding of result.findings) {
    for (const factId of finding.evidenceFactIds) {
      if (!factIds.has(factId)) {
        problems.push(`${finding.ruleId} cites unknown fact ${factId}`);
      }
    }
  }

  // Values attributable to a quarantined document: its subject and every string
  // its body states, less anything a non-quarantined document or the case also states.
  const shared = stringLeaves(fixture.caseRecord, new Set());
  const distinctive = new Set<string>();
  for (const document of fixture.documents) {
    const leaves = stringLeaves(parseBytes(document.raw), new Set(document.meta.subjectId === null ? [] : [document.meta.subjectId]));
    for (const value of leaves) {
      (quarantined.has(document.meta.documentId) ? distinctive : shared).add(value);
    }
  }
  for (const value of shared) {
    distinctive.delete(value);
  }
  for (const finding of result.findings) {
    for (const ref of finding.documentRefs) {
      if (finding.ruleId !== 'R02' && quarantined.has(ref.documentId)) {
        problems.push(`${finding.ruleId} names quarantined document ${ref.documentId}; only R02 may (C07)`);
      }
    }
    for (const value of distinctive) {
      if (finding.explanation.includes(value)) {
        problems.push(`${finding.ruleId} explanation contains text from a quarantined document`);
      }
    }
    if (finding.ruleId !== 'R02') {
      for (const documentId of quarantined) {
        if (finding.explanation.includes(documentId)) {
          problems.push(`${finding.ruleId} explanation names quarantined document ${documentId}; only R02 may (C07)`);
        }
      }
    }
  }
  for (const fact of result.evidenceFacts) {
    if ([...distinctive].some((value) => String(fact.value).includes(value) || fact.originalText.includes(value))) {
      problems.push(`fact ${fact.factId} contains text from a quarantined document`);
    }
  }
  return problems;
}

/** Complete-set comparison: state, quarantine list, and per rule status, role, citations and affected documents. */
export function compareWithOracle(result: AssessmentResult, oracle: Oracle): string[] {
  const problems: string[] = [];
  if (result.state !== oracle.expectedState) {
    problems.push(`state ${result.state}, expected ${oracle.expectedState}`);
  }
  const sameSet = (actual: readonly string[], expected: readonly string[], what: string) => {
    const extra = actual.filter((item) => !expected.includes(item));
    const missing = expected.filter((item) => !actual.includes(item));
    if (extra.length > 0 || missing.length > 0 || new Set(actual).size !== actual.length) {
      problems.push(`${what}: missing [${missing.join(', ')}], unexpected [${extra.join(', ')}]${new Set(actual).size !== actual.length ? ', duplicates' : ''}`);
    }
  };
  sameSet(result.quarantinedDocumentIds, oracle.quarantinedDocumentIds, 'quarantined documents');
  sameSet(
    result.findings.map((finding) => finding.ruleId),
    oracle.expectedFindings.map((finding) => finding.ruleId),
    'findings by rule',
  );
  const facts = new Map(result.evidenceFacts.map((fact) => [fact.factId, fact]));
  for (const expected of oracle.expectedFindings) {
    const actual = result.findings.find((finding) => finding.ruleId === expected.ruleId);
    if (actual === undefined) {
      continue;
    }
    if (actual.status !== expected.status) {
      problems.push(`${expected.ruleId}: status ${actual.status}, expected ${expected.status}`);
    }
    if (actual.responsibleRole !== expected.responsibleRole) {
      problems.push(`${expected.ruleId}: role ${actual.responsibleRole}, expected ${expected.responsibleRole}`);
    }
    const cited = actual.evidenceFactIds.map((factId) => {
      const fact = facts.get(factId);
      return fact === undefined ? `unknown fact ${factId}` : citationKey(fact.documentId, fact.documentVersion, fact.locator);
    });
    sameSet(
      cited,
      expected.citations.map((citation) => citationKey(citation.documentId, citation.documentVersion, citation.locator)),
      `${expected.ruleId} citations`,
    );
    sameSet(actual.documentRefs.map(refKey), expected.affectedDocuments.map(refKey), `${expected.ruleId} affected documents`);
  }
  return problems;
}

/** Runs one fixture end to end: frozen bytes, manifest pin, assessment, validation and comparison. */
export async function evaluateFixture(inputs: FixtureInputs): Promise<FixtureEvaluation> {
  const { fixtureId } = inputs;
  const evaluation: FixtureEvaluation = { fixtureId, expectedState: undefined, actualState: undefined, problems: [], result: undefined };
  evaluation.problems.push(...checkFrozen(fixtureId, inputs.oracleBytes, inputs.packBytes));
  if (evaluation.problems.length > 0) {
    return evaluation;
  }
  const oracle = Oracle.parse(JSON.parse(Buffer.from(inputs.oracleBytes).toString('utf8')));
  const pack = PolicyPack.parse(JSON.parse(Buffer.from(inputs.packBytes).toString('utf8')));
  if (oracle.fixtureId !== fixtureId || oracle.policyPackSha256 !== FROZEN_POLICY_PACK.sha256) {
    evaluation.problems.push('the oracle names another fixture or policy pack');
    return evaluation;
  }
  evaluation.expectedState = oracle.expectedState;
  const check = await checkFixture(join(FIXTURES_DIR, fixtureId));
  if (check.fixture === undefined || check.problems.length > 0) {
    evaluation.problems.push(...check.problems.map((problem) => `fixture: ${problem}`));
    return evaluation;
  }
  const { fixture } = check;
  if (fixture.manifestSha256 !== oracle.fixtureManifestSha256) {
    evaluation.problems.push(`manifest.json SHA-256 ${fixture.manifestSha256} differs from the oracle's fixtureManifestSha256 ${oracle.fixtureManifestSha256}`);
    return evaluation;
  }
  const outcome = await assess({
    caseRecord: fixture.caseRecord,
    documents: fixture.documents.map((document) => ({ meta: document.meta, bytes: document.raw })),
    policyPackBytes: inputs.packBytes,
    assessmentDate: fixture.caseRecord.assessmentDate,
  });
  if (outcome.outcome === 'rejected') {
    evaluation.actualState = 'rejected';
    evaluation.problems.push(...outcome.issues.map((issue) => `rejected: ${issue}`));
    return evaluation;
  }
  evaluation.result = outcome.result;
  evaluation.actualState = outcome.result.state;
  evaluation.problems.push(...validateResult(outcome.result, fixture, oracle, pack), ...compareWithOracle(outcome.result, oracle));
  return evaluation;
}

export interface FalseReady {
  numerator: number;
  denominator: number;
  fixtureIds: string[];
  /** Fixtures whose oracle was refused; they are in neither count. */
  refused: string[];
  /** Fixtures with a trusted oracle whose assessment never ran. */
  notRun: string[];
  /** The count covers every fixture only when nothing was refused or left unrun. */
  complete: boolean;
}

/**
 * False-ready count (SPEC PA-A02): fixtures assessed `ready_for_review` whose
 * trusted oracle expects another state, over every fixture whose trusted oracle
 * expects another state (a scope, identity, required-evidence or chronology
 * blocker). A refused oracle is in neither count, and the count is incomplete.
 */
export function falseReady(evaluations: readonly FixtureEvaluation[]): FalseReady {
  const refused = evaluations.filter((evaluation) => evaluation.expectedState === undefined).map((evaluation) => evaluation.fixtureId);
  const notRun = evaluations.filter((evaluation) => evaluation.expectedState !== undefined && evaluation.actualState === undefined).map((evaluation) => evaluation.fixtureId);
  const blocked = evaluations.filter((evaluation) => evaluation.expectedState !== undefined && evaluation.expectedState !== 'ready_for_review');
  const ready = blocked.filter((evaluation) => evaluation.actualState === 'ready_for_review');
  return {
    numerator: ready.length,
    denominator: blocked.length,
    fixtureIds: ready.map((evaluation) => evaluation.fixtureId),
    refused,
    notRun,
    complete: refused.length === 0 && notRun.length === 0,
  };
}

/** The false-ready summary line; an incomplete count is never stated as a result. */
export function falseReadyLine(evaluations: readonly FixtureEvaluation[]): string {
  const { numerator, denominator, fixtureIds, refused, notRun, complete } = falseReady(evaluations);
  if (!complete) {
    const reasons = [
      ...(refused.length > 0 ? [`${refused.length} ${refused.length === 1 ? 'oracle' : 'oracles'} refused (${refused.join(', ')})`] : []),
      ...(notRun.length > 0 ? [`${notRun.length} ${notRun.length === 1 ? 'fixture' : 'fixtures'} not run (${notRun.join(', ')})`] : []),
    ];
    return `False-ready: not computed, ${reasons.join(', ')}; of the rest, ${numerator} of ${denominator} assessed ready_for_review against a blocked oracle${fixtureIds.length > 0 ? `: ${fixtureIds.join(', ')}` : ''}.`;
  }
  return `False-ready: ${numerator} of ${denominator} fixtures whose oracle expects a state other than ready_for_review (${evaluations.length} fixtures assessed)${fixtureIds.length > 0 ? `: ${fixtureIds.join(', ')}` : ''}.`;
}

/** A Markdown report of every fixture comparison and the false-ready count. */
export function formatReport(evaluations: readonly FixtureEvaluation[]): string {
  const rows = evaluations.map(
    (evaluation) =>
      `| ${evaluation.fixtureId} | ${evaluation.expectedState ?? 'refused'} | ${evaluation.actualState ?? 'not run'} | ${evaluation.problems.length === 0 ? 'yes' : `no (${evaluation.problems.length})`} |`,
  );
  return [
    'Legacy first-slice assessment: rules_only, no provider call.',
    falseReadyLine(evaluations),
    '',
    '| Fixture | Expected state | Actual state | Complete-set match |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    falseReadyLine(evaluations),
    ...evaluations.flatMap((evaluation) => evaluation.problems.map((problem) => `- ${evaluation.fixtureId}: ${problem}`)),
  ].join('\n');
}
