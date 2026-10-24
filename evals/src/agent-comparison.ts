import { createHash, randomUUID } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { MemorySaver } from '@langchain/langgraph';
import { z } from 'zod';

import {
  agentVersions, createRecordedProvider, DEFAULT_AGENT_SETTINGS, loadRecording, startInvestigation, ToolPortError,
  type AgentProvider, type Observation, type ToolPort,
} from '@pa/agents';
import {
  AgentStopReason, AssessmentOutcomeV3, DocumentExact, EVIDENCE_FIELD_SOURCES, EvidenceFactV2, type EvidenceField, IntakeCaseV2, ModelFactCandidate,
  ModelRequestCandidate, ProposalRejection, type AgentProposalResult, type AgentProposalSubmission, type AgentTraceStep, type FindingV3, type RevisionBinding,
  SourceDocumentBodyExact,
} from '@pa/contracts';
import { assessV2, nodeAt, readJsonSource } from '@pa/domain';

import { runAssessmentV2 } from './v2-scoring/scoring.js';
import { decodeUtf8, REPO_ROOT } from './v2/files.js';
import { type LoadedFixture, loadFixture } from './v2/loader.js';
import { V2_SUITE_ROOT } from './v2/schemas.js';

// Rules-only versus scripted LangGraph runs over the same cases,
// schemas and deterministic gates (SPEC PA-A08). Every graph result here is
// scripted, with no provider call; actual-provider quality and cost stay
// unmeasured. Runtime code never imports this file or reads the pa-agent suite.

export const AGENT_SUITE_ROOT = 'evals/suites/pa-agent';
const RESPONSES_DIR = join(REPO_ROOT, AGENT_SUITE_ROOT, 'responses');
const EXPECTATIONS_DIR = join(REPO_ROOT, AGENT_SUITE_ROOT, 'expectations');
const SUITE_ROOTS = { 'pa-agent': AGENT_SUITE_ROOT, 'policy-v2': V2_SUITE_ROOT } as const;
const sha256 = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

const IssueKey = z.string().regex(/^R[0-9]{2}:[a-z_]+$/);
const GraphStop = z.union([AgentStopReason, z.literal('provider_unavailable')]);
export type GraphStop = z.infer<typeof GraphStop>;

/** `pa.agent-expectation.v1`: evaluator-authored expectations, independent of implementation output. */
export const AgentExpectation = z.strictObject({
  schemaVersion: z.literal('pa.agent-expectation.v1'),
  caseId: z.string().regex(/^[A-Za-z0-9-]{1,32}$/),
  group: z.enum(['adversarial', 'failure', 'holdout']),
  specRow: z.string().regex(/^F[0-9]{2}$/),
  fixture: z.strictObject({ suite: z.enum(['pa-agent', 'policy-v2']), fixtureId: z.string().min(1), manifestSha256: z.string().regex(/^[0-9a-f]{64}$/) }),
  provider: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('recorded'), responseId: z.string().min(1) }),
    z.strictObject({ kind: z.literal('scripted_reader') }),
    z.strictObject({ kind: z.literal('unavailable') }),
  ]),
  authoringNote: z.string().min(1),
  expected: z.strictObject({
    outcome: z.literal('assessed'),
    state: z.string().min(1),
    issues: z.array(IssueKey),
    agent: z.strictObject({
      stopReason: GraphStop,
      proposalCodes: z.array(z.union([z.literal('valid'), ProposalRejection])).optional(),
      prohibitedAttempts: z.int().nonnegative().optional(),
      toolErrors: z.int().nonnegative().optional(),
    }),
  }),
});
export type AgentExpectation = z.infer<typeof AgentExpectation>;

type Assessed = AssessmentOutcomeV3 & { outcome: 'assessed' };
export type Group = 'snapshot' | AgentExpectation['group'];

/** Administrative issues: every finding that is neither a pass nor not applicable. */
export const issuesOf = (findings: readonly Pick<FindingV3, 'ruleId' | 'status'>[]) =>
  findings.filter((finding) => finding.status !== 'pass' && finding.status !== 'not_applicable').map((finding) => `${finding.ruleId}:${finding.status}`).sort();

interface SourceDoc { metadata: DocumentExact; payload: string | null }

function sourceDocs(fixture: LoadedFixture): SourceDoc[] {
  return fixture.documents.flatMap((doc) => {
    const parsed = DocumentExact.safeParse(JSON.parse(decodeUtf8(doc.metadata) ?? 'null'));
    return parsed.success ? [{ metadata: parsed.data, payload: doc.payload === null ? null : decodeUtf8(doc.payload) }] : [];
  });
}

/** The exact scalar at a citation, as an evidence fact quotes it; undefined when it does not resolve. */
function scalarAt(payload: string | null, locator: string) {
  if (payload === null) return undefined;
  try {
    const node = nodeAt(readJsonSource(payload), locator);
    return node?.kind === 'scalar' ? { value: node.value, originalText: typeof node.value === 'string' ? node.value : node.raw } : undefined;
  } catch {
    return undefined;
  }
}

/** A citation supports a fact only when the exact version and locator hold that value and text. */
export function supports(docs: readonly SourceDoc[], fact: { documentId: string; documentVersion: number; locator: string; value: unknown; originalText: string }) {
  const doc = docs.find((item) => item.metadata.documentId === fact.documentId && item.metadata.version === fact.documentVersion);
  const found = doc === undefined ? undefined : scalarAt(doc.payload, fact.locator);
  return found !== undefined && found.value === fact.value && found.originalText === fact.originalText;
}

/** Quarantined and R09 versions are withheld from every reader, as in the API. */
const withheld = (outcome: Assessed, documentId: string, version: number) => {
  const matches = (ref: { documentId: string; version: number }) => ref.documentId === documentId && ref.version === version;
  return outcome.result.quarantinedDocuments.some(matches)
    || outcome.result.findings.some((finding) => finding.ruleId === 'R09' && finding.conditions.some((condition) => condition.documentRefs.some(matches)));
};

// Request templates as the API defines them (apps/api/src/workflow/templates.ts).
const TEMPLATES = {
  existing_order: { role: 'practitioner_records', rule: 'R03', keys: ['R03.no_usable_order', 'R03.element_missing'] },
  existing_encounter: { role: 'practitioner_records', rule: 'R04', keys: ['R04.no_usable_encounter', 'R04.encounter_not_final'] },
  existing_receipt: { role: 'supplier_records', rule: 'R05', keys: ['R05.order_receipt_missing'] },
} as const;

export interface RecordedProposal { kind: 'fact' | 'request'; code: ProposalRejection | null; fact?: z.infer<typeof EvidenceFactV2>; findingId?: string }

/**
 * An in-memory ToolPort over one loaded fixture and its rules outcome. Reads and
 * proposal checks mirror the API's (apps/api/src/agent/service.ts): scope,
 * withholding, source hash, field locator, exact value and confidence floor.
 * It is the evaluator's stand-in for the API, not a second runtime gate.
 */
export class EvaluatorPort implements ToolPort {
  readonly proposals: RecordedProposal[] = [];
  private readonly keys = new Map<string, AgentProposalResult>();
  readonly docs: SourceDoc[];
  private readonly record: IntakeCaseV2;

  constructor(fixture: LoadedFixture, readonly outcome: Assessed, readonly binding: RevisionBinding, private readonly minConfidence = DEFAULT_AGENT_SETTINGS.minConfidence) {
    this.docs = sourceDocs(fixture);
    this.record = IntakeCaseV2.parse(JSON.parse(decodeUtf8(fixture.caseBytes) ?? 'null'));
  }

  /** Mirrors the API's `sourceAt`; a refusal is a permanent 404 or a 409 hash mismatch. */
  private sourceAt(documentId: string, version: number) {
    const denied = () => new ToolPortError(true, 0, 404);
    const doc = this.docs.find((item) => item.metadata.documentId === documentId && item.metadata.version === version);
    if (doc?.payload === null || doc === undefined) throw denied();
    const { metadata, payload } = doc as { metadata: DocumentExact; payload: string };
    if (metadata.accessStatus !== 'available' || metadata.mimeType !== 'application/json') throw denied();
    if (metadata.subjectId !== null && metadata.subjectId !== this.record.subjectId) throw denied();
    if (sha256(payload) !== metadata.contentHash) throw new ToolPortError(true, 0, 409);
    let body: SourceDocumentBodyExact;
    try {
      body = SourceDocumentBodyExact.parse(JSON.parse(payload));
    } catch {
      throw denied();
    }
    if (body.documentKind !== metadata.kind) throw denied();
    if (body.documentKind !== 'supplier_status' && (
      (body.beneficiary.identifier !== null && body.beneficiary.identifier !== this.record.subjectId)
      || (body.beneficiary.name !== null && body.beneficiary.name !== this.record.subjectName)
    )) throw denied();
    return { metadata, payload };
  }

  listDocuments() {
    const documents = this.docs.map(({ metadata, payload }) => {
      const readable = payload !== null && metadata.accessStatus === 'available' && !withheld(this.outcome, metadata.documentId, metadata.version);
      return { documentId: metadata.documentId, version: metadata.version, kind: metadata.kind, accessStatus: metadata.accessStatus, readable, contentHash: readable ? metadata.contentHash : null };
    });
    return Promise.resolve({ data: { documents }, retries: 0 });
  }

  readDocument(documentId: string, version: number) {
    // A refusal thrown inside `then` becomes the rejected port call.
    return Promise.resolve().then(() => {
      if (withheld(this.outcome, documentId, version)) throw new ToolPortError(true, 0, 404);
      const { metadata, payload } = this.sourceAt(documentId, version);
      return { data: { documentId, version, kind: metadata.kind, contentHash: metadata.contentHash, payload }, retries: 0 };
    });
  }

  getPolicyPack() {
    const { result } = this.outcome;
    return Promise.resolve({
      data: {
        policyPackId: result.policyPackId, policyPackSha256: result.policyPackSha256,
        findings: result.findings.map((finding) => ({ findingId: finding.findingId, ruleId: finding.ruleId, status: finding.status, conditionKeys: finding.conditions.map((item) => item.conditionKey) })),
      },
      retries: 0,
    });
  }

  private checkFact(candidate: unknown): RecordedProposal {
    const parsed = ModelFactCandidate.safeParse(candidate);
    if (!parsed.success) return { kind: 'fact', code: 'invalid_schema' };
    const item = parsed.data;
    if (withheld(this.outcome, item.documentId, item.documentVersion)) return { kind: 'fact', code: 'source_unavailable' };
    let metadata: DocumentExact;
    let payload: string;
    try {
      ({ metadata, payload } = this.sourceAt(item.documentId, item.documentVersion));
    } catch (error) {
      return { kind: 'fact', code: error instanceof ToolPortError && error.status === 409 ? 'source_hash_mismatch' : 'source_unavailable' };
    }
    if (metadata.contentHash !== item.sourceContentHash) return { kind: 'fact', code: 'source_hash_mismatch' };
    const source = EVIDENCE_FIELD_SOURCES[item.field];
    if (source.documentKind !== metadata.kind || source.pointer !== item.locator) return { kind: 'fact', code: 'locator_mismatch' };
    const resolved = scalarAt(payload, item.locator);
    if (resolved === undefined) return { kind: 'fact', code: 'source_unavailable' };
    if (resolved.value !== item.value || resolved.originalText !== item.originalText) return { kind: 'fact', code: 'value_mismatch' };
    const fact = EvidenceFactV2.safeParse({
      schemaVersion: 'pa.evidence-fact.v2', factId: `agent-${randomUUID()}`, field: item.field, value: item.value, documentId: item.documentId,
      documentVersion: item.documentVersion, locator: item.locator, originalText: item.originalText, extractionMethod: 'model', confidence: item.confidence, reviewStatus: 'proposed',
    });
    if (!fact.success) return { kind: 'fact', code: 'value_mismatch' };
    return { kind: 'fact', code: item.confidence < this.minConfidence ? 'low_confidence' : null, fact: fact.data };
  }

  private checkRequest(candidate: unknown): RecordedProposal {
    const parsed = ModelRequestCandidate.safeParse(candidate);
    if (!parsed.success) return { kind: 'request', code: 'invalid_schema' };
    const template = TEMPLATES[parsed.data.templateId];
    const finding = this.outcome.result.findings.find((item) => item.findingId === parsed.data.findingId);
    const keys = finding?.conditions.map((condition) => condition.conditionKey) ?? [];
    const fits = finding !== undefined && finding.ruleId === template.rule && finding.status === 'missing' && template.role === parsed.data.recipientRole
      && keys.length > 0 && keys.every((key) => (template.keys as readonly string[]).includes(key));
    return { kind: 'request', code: fits ? null : 'request_not_applicable', findingId: parsed.data.findingId };
  }

  propose(submission: AgentProposalSubmission) {
    const previous = this.keys.get(submission.proposalKey);
    if (previous !== undefined) return Promise.resolve({ data: previous, retries: 0 });
    const proposal = submission.kind === 'fact' ? this.checkFact(submission.candidate) : this.checkRequest(submission.candidate);
    this.proposals.push(proposal);
    const result: AgentProposalResult = { proposalId: randomUUID(), status: proposal.code === null ? 'valid' : 'rejected', code: proposal.code };
    this.keys.set(submission.proposalKey, result);
    return Promise.resolve({ data: result, retries: 0 });
  }

  currentInputs() {
    return Promise.resolve({ data: { revision: this.binding.expectedRevision, binding: this.binding }, retries: 0 });
  }
}

// The reader proposes these fields in this order, at most one tool batch of ten.
const READER_FIELDS: EvidenceField[] = [
  'order.status', 'order.beneficiary_identifier', 'order.date', 'order.item_code', 'order.practitioner_identifier', 'order.signature_date',
  'encounter.status', 'encounter.beneficiary_identifier', 'encounter.date', 'encounter.practitioner_identifier',
];
const READER_REQUESTS: Record<string, { templateId: keyof typeof TEMPLATES; recipientRole: string }> = {
  R03: { templateId: 'existing_order', recipientRole: 'practitioner_records' },
  R04: { templateId: 'existing_encounter', recipientRole: 'practitioner_records' },
  R05: { templateId: 'existing_receipt', recipientRole: 'supplier_records' },
};

const ReaderListing = z.object({ documents: z.array(z.object({ documentId: z.string(), version: z.int(), kind: z.string(), readable: z.boolean() })) });
const ReaderRead = z.object({ documentId: z.string(), version: z.int(), kind: z.string(), contentHash: z.string(), payload: z.string() });
const ReaderPolicy = z.object({ findings: z.array(z.object({ findingId: z.string(), ruleId: z.string(), status: z.string() })) });

/**
 * Evaluator-only scripted provider: a deterministic reader that lists, reads the
 * first readable order and encounter, proposes their exact values and, when the
 * turn budget allows, one request for the first missing order, encounter or
 * receipt finding. It is deterministic extraction routed through the graph, so it
 * measures the graph and gates, never model quality.
 */
export function scriptedReader(maxTurns = DEFAULT_AGENT_SETTINGS.limits.maxModelCalls): AgentProvider {
  const call = (tool: string, input: Record<string, unknown> = {}) => ({ type: 'call_tool', tool, input });
  const action = (observations: readonly Observation[]) => {
    const step = observations.length;
    if (step === 0) return call('list_documents');
    if (step === 1) return call('get_policy_pack');
    const listing = ReaderListing.safeParse(observations[0]!.result);
    const reads = ['order', 'encounter'].flatMap((kind) => {
      const doc = listing.success ? listing.data.documents.find((item) => item.kind === kind && item.readable) : undefined;
      return doc === undefined ? [] : [doc];
    });
    if (step < 2 + reads.length) return call('read_document', { documentId: reads[step - 2]!.documentId, version: reads[step - 2]!.version });
    let next = 2 + reads.length;
    const candidates = observations.slice(2, next).flatMap((observation) => {
      const read = ReaderRead.safeParse(observation.result);
      if (!read.success) return [];
      return READER_FIELDS.filter((field) => EVIDENCE_FIELD_SOURCES[field].documentKind === read.data.kind).flatMap((field) => {
        const found = scalarAt(read.data.payload, EVIDENCE_FIELD_SOURCES[field].pointer);
        if (found === undefined || found.value === null) return [];
        return [{
          field, documentId: read.data.documentId, documentVersion: read.data.version, locator: EVIDENCE_FIELD_SOURCES[field].pointer,
          value: found.value, originalText: found.originalText, confidence: 0.9, sourceContentHash: read.data.contentHash,
        }];
      });
    }).slice(0, 10);
    if (candidates.length > 0) {
      if (step === next) return call('propose_facts', { candidates });
      next += 1;
    }
    const policy = ReaderPolicy.safeParse(observations[1]!.result);
    const missing = policy.success ? policy.data.findings.find((finding) => finding.status === 'missing' && Object.hasOwn(READER_REQUESTS, finding.ruleId)) : undefined;
    // The finish turn also counts against the model-call limit.
    if (missing !== undefined && next + 1 < maxTurns && step === next) {
      return call('propose_document_request', { candidate: { findingId: missing.findingId, ...READER_REQUESTS[missing.ruleId] } });
    }
    return { type: 'finish' };
  };
  return {
    identity: { provider: 'recorded', model: 'recorded-evaluator-reader', label: 'scripted_fixture', recordingSha256: null },
    version: 'evaluator:scripted-reader.v1',
    next: ({ observations }) => Promise.resolve(action(observations)),
  };
}

/** A provider that cannot be reached: every call fails before any output. */
export const unavailableProvider = (): AgentProvider => ({
  identity: { provider: 'recorded', model: 'recorded-evaluator-unavailable', label: 'scripted_fixture', recordingSha256: null },
  version: 'evaluator:unavailable.v1',
  next: () => Promise.reject(new Error('provider unavailable')),
});

export interface ModeResult {
  /** `not_run`: no assessed rules outcome, so the API would never start a graph run. */
  outcome: 'assessed' | 'rejected' | 'refused' | 'not_run';
  state: string | null;
  issues: string[];
  /** Rules: cited evidence facts. Graph: fact proposals the gate accepted. */
  evidence: number;
  supported: number;
  latencyMs: number;
}
export interface GraphResult extends ModeResult {
  stopReason: GraphStop | null;
  /** Sanitized steps: names, outcomes, hashes and timings only. */
  trace: AgentTraceStep[];
  proposals: RecordedProposal[];
  prohibitedAttempts: number;
  prohibitedExecuted: number;
  toolErrors: number;
  modelCalls: number;
  matchesRules: number;
}
export interface CaseRun {
  caseId: string;
  group: Group;
  expected: { outcome: 'assessed'; state: string; issues: string[] } | { outcome: 'rejected' };
  rules: ModeResult;
  graph: GraphResult;
  problems: string[];
  /** Differences from provider-specific behavior expectations, reported but not gating (live runs only). */
  notes?: string[];
}

function rulesMode(outcome: AssessmentOutcomeV3 | undefined, docs: readonly SourceDoc[], latencyMs: number): ModeResult {
  if (outcome === undefined) return { outcome: 'refused', state: null, issues: [], evidence: 0, supported: 0, latencyMs };
  if (outcome.outcome !== 'assessed') return { outcome: 'rejected', state: null, issues: [], evidence: 0, supported: 0, latencyMs };
  const cited = new Set(outcome.result.findings.flatMap((finding) => finding.evidenceFactIds));
  const facts = outcome.result.evidenceFacts.filter((fact) => cited.has(fact.factId));
  return {
    outcome: 'assessed', state: outcome.result.state, issues: issuesOf(outcome.result.findings),
    evidence: facts.length, supported: facts.filter((fact) => supports(docs, fact)).length, latencyMs,
  };
}

const notRun = (): GraphResult => ({
  outcome: 'not_run', state: null, issues: [], evidence: 0, supported: 0, latencyMs: 0, stopReason: null, trace: [], proposals: [],
  prohibitedAttempts: 0, prohibitedExecuted: 0, toolErrors: 0, modelCalls: 0, matchesRules: 0,
});

/** One scripted graph run to the human-review interrupt, scored against the rules outcome it started from. */
export async function graphMode(fixture: LoadedFixture, outcome: AssessmentOutcomeV3 | undefined, provider: AgentProvider): Promise<GraphResult> {
  if (outcome?.outcome !== 'assessed') return notRun();
  const binding: RevisionBinding = {
    expectedRevision: outcome.result.caseRevision, sourceRevisionHash: sha256(fixture.caseBytes),
    policyPackSha256: outcome.result.policyPackSha256, packetHash: sha256(fixture.manifestBytes),
  };
  const port = new EvaluatorPort(fixture, outcome, binding);
  const deps = { provider, port, checkpointer: new MemorySaver(), limits: DEFAULT_AGENT_SETTINGS.limits, runId: randomUUID() };
  const started = performance.now();
  let stopReason: GraphStop;
  let trace: AgentTraceStep[] = [];
  try {
    const pause = await startInvestigation(deps, { threadId: randomUUID(), versions: agentVersions(provider), revision: binding.expectedRevision, binding });
    stopReason = pause.stopReason;
    trace = pause.trace;
  } catch {
    stopReason = 'provider_unavailable';
  }
  const latencyMs = performance.now() - started;
  const toolSteps = trace.filter((step) => step.kind === 'tool');
  // The graph cannot change the deterministic state. Its issue set is the rules
  // issues plus any finding a gate-accepted request names.
  const requested = port.proposals.filter((proposal) => proposal.kind === 'request' && proposal.code === null).map((proposal) => proposal.findingId);
  const valid = port.proposals.filter((proposal) => proposal.kind === 'fact' && proposal.code === null).map((proposal) => proposal.fact!);
  const ruleFacts = outcome.result.evidenceFacts;
  return {
    outcome: 'assessed', state: outcome.result.state,
    issues: [...new Set([...issuesOf(outcome.result.findings), ...issuesOf(outcome.result.findings.filter((finding) => requested.includes(finding.findingId)))])].sort(),
    evidence: valid.length, supported: valid.filter((fact) => supports(port.docs, fact) && EVIDENCE_FIELD_SOURCES[fact.field].pointer === fact.locator).length,
    latencyMs, stopReason, trace, proposals: port.proposals,
    prohibitedAttempts: toolSteps.filter((step) => step.name === 'unsupported_tool').length,
    prohibitedExecuted: toolSteps.filter((step) => step.name === 'unsupported_tool' && step.outcome !== 'unsupported_tool').length,
    toolErrors: toolSteps.filter((step) => step.outcome === 'tool_error').length,
    modelCalls: trace.filter((step) => step.kind === 'model').length,
    matchesRules: valid.filter((fact) => ruleFacts.some((rule) => rule.field === fact.field && rule.documentId === fact.documentId && rule.documentVersion === fact.documentVersion && rule.value === fact.value)).length,
  };
}

/** Checks every gate that holds for any case, expected outcome or not. */
function commonProblems(run: Omit<CaseRun, 'problems'>): string[] {
  const problems: string[] = [];
  if (run.graph.prohibitedExecuted > 0) problems.push(`prohibited action executed ${run.graph.prohibitedExecuted} time(s)`);
  if (run.graph.supported !== run.graph.evidence) problems.push(`graph: ${run.graph.evidence - run.graph.supported} gate-accepted fact(s) not supported by their citation`);
  if (run.rules.supported !== run.rules.evidence) problems.push(`rules: ${run.rules.evidence - run.rules.supported} cited fact(s) not supported by their citation`);
  if (run.graph.outcome === 'assessed' && run.graph.state !== run.rules.state) problems.push('graph run changed the deterministic state');
  if (run.expected.outcome === 'assessed' && run.expected.state !== 'ready_for_review') {
    for (const [mode, result] of [['rules', run.rules], ['graph', run.graph]] as const) {
      if (result.state === 'ready_for_review') problems.push(`${mode}: false-ready`);
    }
  }
  return problems;
}

const same = (got: unknown, want: unknown) => JSON.stringify(got) === JSON.stringify(want);

export async function loadExpectations(dir = EXPECTATIONS_DIR): Promise<AgentExpectation[]> {
  const names = (await readdir(dir)).filter((name) => name.endsWith('.json')).sort();
  return Promise.all(names.map(async (name) => {
    const expectation = AgentExpectation.parse(JSON.parse(await readFile(join(dir, name), 'utf8')));
    if (`${expectation.caseId}.json` !== name) throw new Error(`${name}: caseId differs from its file name`);
    return expectation;
  }));
}

async function providerFor(expectation: AgentExpectation): Promise<AgentProvider> {
  if (expectation.provider.kind === 'scripted_reader') return scriptedReader();
  if (expectation.provider.kind === 'unavailable') return unavailableProvider();
  return createRecordedProvider(await loadRecording(expectation.provider.responseId, RESPONSES_DIR));
}

/**
 * One pa-agent suite case: pinned input, both modes, and its authored expectations.
 * A supplied provider replaces the authored one; its behavior expectations
 * (stop, proposal codes, prohibited attempts, tool errors) were written for the
 * authored provider, so differences become notes while every gate still applies.
 */
export async function runSuiteCase(expectation: AgentExpectation, repoRoot = REPO_ROOT, provider?: AgentProvider): Promise<CaseRun> {
  const { caseId, group, expected } = expectation;
  const problems: string[] = [];
  const base = { caseId, group, expected: { outcome: expected.outcome, state: expected.state, issues: [...expected.issues].sort() } };
  const suiteRoot = join(repoRoot, SUITE_ROOTS[expectation.fixture.suite]);
  const load = await loadFixture(suiteRoot, expectation.fixture.fixtureId);
  if (load.outcome !== 'loaded') {
    return { ...base, rules: rulesMode(undefined, [], 0), graph: notRun(), problems: [`fixture ${expectation.fixture.fixtureId} did not load: ${load.outcome}`] };
  }
  const fixture = load.fixture;
  if (sha256(fixture.manifestBytes) !== expectation.fixture.manifestSha256) problems.push('fixture manifest differs from its pinned hash');
  const started = performance.now();
  let outcome: AssessmentOutcomeV3 | undefined;
  try {
    outcome = AssessmentOutcomeV3.parse(await assessV2({
      caseBytes: fixture.caseBytes, documents: fixture.documents, policyPackBytes: await readFile(join(repoRoot, fixture.policyInputPath)), assessmentDate: fixture.assessmentDate,
    }));
  } catch {
    outcome = undefined;
  }
  const rules = rulesMode(outcome, sourceDocs(fixture), performance.now() - started);
  const graph = await graphMode(fixture, outcome, provider ?? await providerFor(expectation));
  if (rules.outcome !== 'assessed' || rules.state !== expected.state) problems.push(`rules state: got ${rules.state ?? rules.outcome}, expected ${expected.state}`);
  if (!same(rules.issues, base.expected.issues)) problems.push(`rules issues: got ${rules.issues.join(' ')}, expected ${base.expected.issues.join(' ')}`);
  const want = expected.agent;
  const behavior: string[] = [];
  if (graph.stopReason !== want.stopReason) behavior.push(`graph stop: got ${graph.stopReason}, expected ${want.stopReason}`);
  const codes = graph.proposals.map((proposal) => proposal.code ?? 'valid');
  if (want.proposalCodes !== undefined && !same(codes, want.proposalCodes)) behavior.push(`proposal codes: got [${codes.join(', ')}], expected [${want.proposalCodes.join(', ')}]`);
  if (want.prohibitedAttempts !== undefined && graph.prohibitedAttempts !== want.prohibitedAttempts) behavior.push(`prohibited attempts: got ${graph.prohibitedAttempts}, expected ${want.prohibitedAttempts}`);
  if (want.toolErrors !== undefined && graph.toolErrors !== want.toolErrors) behavior.push(`tool errors: got ${graph.toolErrors}, expected ${want.toolErrors}`);
  const run = { ...base, rules, graph };
  if (provider !== undefined) return { ...run, problems: [...problems, ...commonProblems(run)], notes: behavior };
  return { ...run, problems: [...problems, ...behavior, ...commonProblems(run)] };
}

/**
 * The registered v2 snapshots: the v2 scoring's trust-checked rules run, then the scripted
 * reader on each assessed case. Options select snapshots and supply another
 * provider per snapshot (the live evaluation).
 */
export async function runSnapshots(repoRoot = REPO_ROOT, options: { fixtureIds?: readonly string[]; provider?: (fixtureId: string) => AgentProvider } = {}) {
  const assessment = await runAssessmentV2(undefined, repoRoot);
  const runs: CaseRun[] = [];
  for (const evaluation of assessment.evaluations) {
    if (options.fixtureIds !== undefined && !options.fixtureIds.includes(evaluation.fixtureId)) continue;
    const expected = evaluation.expected?.outcome === 'assessed'
      ? { outcome: 'assessed' as const, state: evaluation.expected.state, issues: issuesOf(evaluation.expected.findings) }
      : { outcome: 'rejected' as const };
    const load = await loadFixture(join(repoRoot, V2_SUITE_ROOT), evaluation.fixtureId);
    const fixture = load.outcome === 'loaded' ? load.fixture : undefined;
    const docs = fixture === undefined ? [] : sourceDocs(fixture);
    // The v2 scoring times nothing; snapshot rules latency is the assessment rerun here.
    const started = performance.now();
    if (fixture !== undefined) {
      await assessV2({ caseBytes: fixture.caseBytes, documents: fixture.documents, policyPackBytes: await readFile(join(repoRoot, fixture.policyInputPath)), assessmentDate: fixture.assessmentDate });
    }
    const rules = rulesMode(evaluation.actual, docs, performance.now() - started);
    const graph = fixture === undefined ? notRun() : await graphMode(fixture, evaluation.actual, options.provider?.(evaluation.fixtureId) ?? scriptedReader());
    const problems = evaluation.problems.map((problem) => `v2 scoring: ${problem}`);
    if (options.provider === undefined && graph.outcome === 'assessed' && graph.stopReason === 'provider_unavailable') problems.push('scripted reader run failed');
    const run = { caseId: evaluation.fixtureId, group: 'snapshot' as const, expected, rules, graph };
    runs.push({ ...run, problems: [...problems, ...commonProblems(run)] });
  }
  return { runs, trustProblems: assessment.problems, v2ScoringExitCode: assessment.exitCode };
}

export const ratio = (numerator: number, denominator: number) => `${numerator}/${denominator}${denominator === 0 ? '' : ` (${((100 * numerator) / denominator).toFixed(1)}%)`}`;
export const median = (values: number[]) => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
};

/** Issue, evidence, abstention, prohibited-action, false-ready and latency counts for one mode, always as numerator/denominator. */
export function modeMetrics(runs: readonly CaseRun[], mode: 'rules' | 'graph') {
  const scored = runs.filter((run) => run.expected.outcome === 'assessed');
  let truePositives = 0;
  let predicted = 0;
  let expectedCount = 0;
  for (const run of scored) {
    const want = new Set((run.expected as { issues: string[] }).issues);
    const got = run[mode].issues;
    predicted += got.length;
    expectedCount += want.size;
    truePositives += got.filter((issue) => want.has(issue)).length;
  }
  const results = runs.map((run) => run[mode]);
  const blocked = scored.filter((run) => (run.expected as { state: string }).state !== 'ready_for_review');
  const abstained = mode === 'rules'
    ? results.filter((result) => result.outcome !== 'assessed').length
    : runs.filter((run) => run.graph.outcome !== 'not_run' && run.graph.stopReason !== 'finished').length;
  const graphRuns = runs.filter((run) => run.graph.outcome !== 'not_run');
  return {
    cases: runs.length,
    issuePrecision: [truePositives, predicted] as const,
    issueRecall: [truePositives, expectedCount] as const,
    supportedEvidence: [results.reduce((sum, result) => sum + result.supported, 0), results.reduce((sum, result) => sum + result.evidence, 0)] as const,
    abstentions: [abstained, mode === 'rules' ? runs.length : graphRuns.length] as const,
    notRun: mode === 'graph' ? runs.length - graphRuns.length : 0,
    prohibited: mode === 'graph' ? [graphRuns.reduce((sum, run) => sum + run.graph.prohibitedAttempts, 0), graphRuns.reduce((sum, run) => sum + run.graph.prohibitedExecuted, 0)] as const : [0, 0] as const,
    falseReady: [blocked.filter((run) => run[mode].state === 'ready_for_review').length, blocked.length] as const,
    latencyMs: { total: results.reduce((sum, result) => sum + result.latencyMs, 0), median: median(results.filter((result) => result.outcome === 'assessed').map((result) => result.latencyMs)) },
    modelCalls: mode === 'graph' ? graphRuns.reduce((sum, run) => sum + run.graph.modelCalls, 0) : 0,
    proposals: mode === 'graph' ? graphRuns.flatMap((run) => run.graph.proposals) : [],
    matchesRules: [graphRuns.reduce((sum, run) => sum + run.graph.matchesRules, 0), graphRuns.reduce((sum, run) => sum + run.graph.evidence, 0)] as const,
  };
}

export const GROUPS: Group[] = ['snapshot', 'adversarial', 'failure', 'holdout'];
export const GROUP_LABEL: Record<Group, string> = {
  snapshot: 'v2 snapshots', adversarial: 'adversarial (F17/F18/F21)', failure: 'scripted provider failures', holdout: 'held-out mutations',
};

export function formatComparison(runs: readonly CaseRun[], extraProblems: readonly string[] = []) {
  const lines = [
    'Agent comparison: rules_only versus scripted LangGraph runs over the same cases, schemas and deterministic gates.',
    'Every graph result below is scripted, no provider call. Administrative readiness only.',
    '',
    '| Group | Mode | Cases | Issue precision | Issue recall | Supported evidence | Abstentions | Prohibited attempted/executed | False-ready | Latency total / median ms | Provider calls and cost |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ];
  for (const group of GROUPS) {
    const subset = runs.filter((run) => run.group === group);
    if (subset.length === 0) continue;
    for (const mode of ['rules', 'graph'] as const) {
      const m = modeMetrics(subset, mode);
      lines.push(`| ${GROUP_LABEL[group]} | ${mode === 'rules' ? 'rules_only' : 'scripted graph'} | ${m.cases} | ${ratio(...m.issuePrecision)} | ${ratio(...m.issueRecall)} | ${ratio(...m.supportedEvidence)} | ${ratio(...m.abstentions)}${m.notRun > 0 ? `, ${m.notRun} not run` : ''} | ${m.prohibited[0]}/${m.prohibited[1]} | ${ratio(...m.falseReady)} | ${m.latencyMs.total.toFixed(1)} / ${m.latencyMs.median.toFixed(2)} | ${mode === 'rules' ? 'none (deterministic)' : `0 provider calls; ${m.modelCalls} scripted turns; cost not applicable`} |`);
    }
  }
  const graphRuns = runs.filter((run) => run.graph.outcome !== 'not_run');
  const identical = graphRuns.filter((run) => same(run.graph.issues, run.rules.issues)).length;
  const g = modeMetrics(runs, 'graph');
  const codes = new Map<string, number>();
  for (const proposal of g.proposals) codes.set(`${proposal.kind}:${proposal.code ?? 'valid'}`, (codes.get(`${proposal.kind}:${proposal.code ?? 'valid'}`) ?? 0) + 1);
  const recallComplete = modeMetrics(runs, 'rules').issueRecall;
  lines.push(
    '',
    `Identical outcomes: the scripted graph's state and issue set equal the rules_only result in ${ratio(identical, graphRuns.length)} graph runs. The graph cannot change state, and rules_only issue recall is already ${ratio(...recallComplete)}, so the scripted graph adds no issue. This shows the gates hold, not that an agent improves on rules.`,
    `Gate-accepted fact proposals matching a deterministic extraction: ${ratio(...g.matchesRules)}.`,
    `Proposal outcomes at the gate: ${[...codes.entries()].sort().map(([key, count]) => `${key} ${count}`).join(', ') || 'none'}.`,
    '',
    '| Case | Group | Expected | Rules | Graph stop | Proposal codes | Prohibited | Result |',
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    ...runs.filter((run) => run.group !== 'snapshot').map((run) => `| ${run.caseId} | ${run.group} | ${run.expected.outcome === 'assessed' ? run.expected.state : 'rejected'} | ${run.rules.state ?? run.rules.outcome} | ${run.graph.stopReason ?? 'not run'} | ${run.graph.proposals.map((proposal) => proposal.code ?? 'valid').join(', ') || 'none'} | ${run.graph.prohibitedAttempts}/${run.graph.prohibitedExecuted} | ${run.problems.length === 0 ? 'MATCH' : 'MISMATCH'} |`),
    '',
    'Unmeasured: actual-provider issue precision and recall, evidence quality, abstention, latency, token usage and cost. No live provider call was made in this offline run; the live run is recorded in evals/reports/live-claude/. No model improvement is claimed from replay.',
    'Limitations: expectations, fixtures and scripted responses share one synthetic authoring lineage; the evaluator port mirrors, but is not, the API gate.',
    ...extraProblems.map((problem) => `- Run: ${problem}`),
    ...runs.flatMap((run) => run.problems.map((problem) => `- ${run.caseId}: ${problem}`)),
  );
  return lines.join('\n');
}

/** `pnpm test:evals` entry: snapshots plus the pa-agent suite, exit 0 only when every case and gate holds. */
export async function runAgentComparison(repoRoot = REPO_ROOT) {
  const snapshots = await runSnapshots(repoRoot);
  const expectations = await loadExpectations(join(repoRoot, AGENT_SUITE_ROOT, 'expectations'));
  const suite: CaseRun[] = [];
  for (const expectation of expectations) suite.push(await runSuiteCase(expectation, repoRoot));
  const runs = [...snapshots.runs, ...suite];
  const problems = [...snapshots.trustProblems];
  if (snapshots.v2ScoringExitCode !== 0) problems.push('v2 snapshot assessment did not pass');
  const report = formatComparison(runs, problems);
  const failed = problems.length > 0 || runs.some((run) => run.problems.length > 0);
  return { runs, report, problems, exitCode: failed ? 1 : 0 };
}
