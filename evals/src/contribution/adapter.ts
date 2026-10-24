import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

import { MemorySaver } from '@langchain/langgraph';

import { agentVersions, DEFAULT_LIMITS, startInvestigation, type AgentLimits, type AgentProvider } from '@pa/agents';
import {
  AssessmentOutcomeV3, DocumentExact, type AgentProposalSubmission, type AgentTraceStep, type AssessmentResultV3, type ProposalRejection, type RevisionBinding,
} from '@pa/contracts';
import { assessV2 } from '@pa/domain';

import { EvaluatorPort } from '../agent-comparison.js';
import { decodeUtf8, REPO_ROOT } from '../v2/files.js';
import { type LoadedFixture, loadFixture } from '../v2/loader.js';
import { CONTRIBUTION_SUITE_ROOT, sha256 } from './package.js';

// Contribution evaluator adapter. Both arms see the same loaded bytes, assessment
// date, policy pack and authoritative rules outcome. The adapter only records
// what each arm emitted, in order; it never reads gold. Scoring is separate
// (scorer.ts). The graph arm runs the real LangGraph investigation over the
// evaluator port (agent-comparison.ts), which mirrors but is not the API gate.

export const ADAPTER_VERSION = 'pa.contribution-adapter.v2';

export type Arm = 'rules_only' | 'scripted_fake';
export type FactGate = 'valid' | ProposalRejection | 'malformed_batch' | 'deterministic';
export type RequestGate = 'valid' | ProposalRejection | 'malformed_call';

/** One emitted fact prediction, verbatim. `readBefore` is whether a successful read of the cited version preceded it. */
export interface FactAttempt { sequence: number; candidate: unknown; gate: FactGate; readBefore: boolean }
export interface RequestAttempt { sequence: number; candidate: unknown; gate: RequestGate }

export interface SourceDocument { metadata: DocumentExact; payload: string | null }

/** The inputs both arms share, loaded once per case. */
export interface CaseSnapshot {
  caseId: string;
  fixture: LoadedFixture;
  manifestSha256: string;
  policyPackSha256: string;
  documents: SourceDocument[];
  intake: unknown;
  /** The authoritative deterministic outcome; the graph cannot change it. */
  outcome: AssessmentResultV3;
}

export interface ArmOutput {
  caseId: string;
  arm: Arm;
  /** `rules_only`, or `fake:<name>`: never model evidence. */
  label: string;
  /** `completed` only for an assessed rules run or a graph run that stopped with `finished`. */
  completion: 'completed' | 'not_completed';
  /** `assessed` (rules), a graph stop reason, `provider_failure`, or `not_attempted`. */
  stopReason: string;
  factAttempts: FactAttempt[];
  requestAttempts: RequestAttempt[];
  /** The SPEC accepted surface: rules cited deterministic facts, or gate-valid model fact proposals. */
  acceptedFacts: unknown[];
  malformedTurns: number;
  modelCalls: number;
  toolCalls: number;
  unsupportedToolAttempts: number;
  unsupportedToolExecuted: number;
  latencyMs: number;
  trace: AgentTraceStep[];
}

/** Loads one regression case through the v2 loader and runs the pure assessment once. */
export async function loadSnapshot(caseId: string, repoRoot = REPO_ROOT): Promise<CaseSnapshot> {
  const load = await loadFixture(join(repoRoot, CONTRIBUTION_SUITE_ROOT), caseId);
  if (load.outcome !== 'loaded') throw new Error(`${caseId}: fixture ${load.outcome}`);
  const { fixture } = load;
  const pack = await readFile(join(repoRoot, fixture.policyInputPath));
  const outcome = AssessmentOutcomeV3.parse(await assessV2({ caseBytes: fixture.caseBytes, documents: fixture.documents, policyPackBytes: pack, assessmentDate: fixture.assessmentDate }));
  if (outcome.outcome !== 'assessed') throw new Error(`${caseId}: rules assessment was not assessed`);
  const documents = fixture.documents.map((doc) => ({
    metadata: DocumentExact.parse(JSON.parse(decodeUtf8(doc.metadata) ?? 'null')),
    payload: doc.payload === null ? null : decodeUtf8(doc.payload),
  }));
  return {
    caseId, fixture, manifestSha256: sha256(fixture.manifestBytes), policyPackSha256: sha256(pack), documents,
    intake: JSON.parse(decodeUtf8(fixture.caseBytes) ?? 'null'), outcome: outcome.result,
  };
}

/** The rules-only arm: its cited deterministic evidence facts, no requests. */
export function rulesArm(snapshot: CaseSnapshot, latencyMs = 0): ArmOutput {
  const cited = new Set(snapshot.outcome.findings.flatMap((finding) => finding.evidenceFactIds));
  const hashOf = (documentId: string, version: number) => snapshot.documents.find((doc) => doc.metadata.documentId === documentId && doc.metadata.version === version)?.metadata.contentHash ?? null;
  const facts = snapshot.outcome.evidenceFacts.filter((fact) => cited.has(fact.factId)).map((fact) => ({
    field: fact.field, documentId: fact.documentId, documentVersion: fact.documentVersion, locator: fact.locator, value: fact.value,
    originalText: fact.originalText, confidence: fact.confidence, sourceContentHash: hashOf(fact.documentId, fact.documentVersion), extractionMethod: fact.extractionMethod,
  }));
  return {
    caseId: snapshot.caseId, arm: 'rules_only', label: 'rules_only', completion: 'completed', stopReason: 'assessed',
    factAttempts: facts.map((candidate, sequence) => ({ sequence, candidate, gate: 'deterministic', readBefore: true })),
    requestAttempts: [], acceptedFacts: facts, malformedTurns: 0, modelCalls: 0, toolCalls: 0, unsupportedToolAttempts: 0, unsupportedToolExecuted: 0, latencyMs, trace: [],
  };
}

/** Records every successful read and every proposal submission in call order. */
class RecordingPort extends EvaluatorPort {
  sequence = 0;
  readonly reads: { sequence: number; key: string }[] = [];
  readonly facts: FactAttempt[] = [];
  readonly requests: RequestAttempt[] = [];

  override async readDocument(documentId: string, version: number) {
    const result = await super.readDocument(documentId, version);
    this.reads.push({ sequence: this.sequence++, key: `${documentId}@${version}` });
    return result;
  }

  override async propose(submission: AgentProposalSubmission) {
    const sequence = this.sequence++;
    const result = await super.propose(submission);
    const gate = result.data.code ?? 'valid';
    if (submission.kind === 'fact') {
      const candidate = submission.candidate as { documentId?: unknown; documentVersion?: unknown } | null;
      const key = `${String(candidate?.documentId)}@${String(candidate?.documentVersion)}`;
      this.facts.push({ sequence, candidate: submission.candidate, gate, readBefore: this.reads.some((read) => read.key === key && read.sequence < sequence) });
    } else {
      this.requests.push({ sequence, candidate: submission.candidate, gate });
    }
    return result;
  }
}

/** Run-plan limits: six provider turns, ten tools, 180 seconds. */
export const RUN_PLAN_LIMITS: AgentLimits = { ...DEFAULT_LIMITS, maxModelCalls: 6, maxToolCalls: 10, maxRunSeconds: 180 };

/**
 * One graph investigation to the human-review interrupt with an evaluator-only
 * provider. Only a recorded, scripted-fixture provider is accepted, because every
 * output here is labelled a fake; a live arm needs its own labelled path.
 */
export async function graphArm(snapshot: CaseSnapshot, provider: AgentProvider, label: string, limits: AgentLimits = RUN_PLAN_LIMITS): Promise<ArmOutput> {
  if (provider.identity.provider !== 'recorded' || provider.identity.label !== 'scripted_fixture') throw new Error('graphArm runs evaluator fakes only: the provider must be recorded and labelled scripted_fixture');
  const binding: RevisionBinding = {
    expectedRevision: snapshot.outcome.caseRevision, sourceRevisionHash: sha256(snapshot.fixture.caseBytes),
    policyPackSha256: snapshot.outcome.policyPackSha256, packetHash: snapshot.manifestSha256,
  };
  const port = new RecordingPort(snapshot.fixture, { schemaVersion: 'pa.assessment-outcome.v3', outcome: 'assessed', result: snapshot.outcome }, binding);
  // Raw turns in order, each with a sequence slot, so a batch the tool schema refuses can still be enumerated.
  const turns: { raw: unknown; sequence: number }[] = [];
  const recording: AgentProvider = {
    ...provider,
    next: async (context) => {
      const raw = await provider.next(context);
      turns.push({ raw, sequence: port.sequence++ });
      return raw;
    },
  };
  const started = performance.now();
  let stopReason: string;
  let trace: AgentTraceStep[] = [];
  try {
    const pause = await startInvestigation(
      { provider: recording, port, checkpointer: new MemorySaver(), limits, runId: randomUUID() },
      { threadId: randomUUID(), versions: agentVersions(provider), revision: binding.expectedRevision, binding },
    );
    stopReason = pause.stopReason;
    trace = pause.trace;
  } catch {
    stopReason = 'provider_failure';
  }
  const latencyMs = performance.now() - started;
  const tools = trace.filter((step) => step.kind === 'tool');
  // A call the tool schema refused never reached the port. Each candidate of an
  // enumerable fact batch (for example eleven, over the limit of ten) is one
  // unsupported attempt; a batch without one, or an empty one, is a single attempt.
  const factAttempts = [...port.facts];
  const requestAttempts = [...port.requests];
  let models = 0;
  for (const step of trace) {
    if (step.kind === 'model') models += 1;
    if (step.kind !== 'tool' || step.outcome !== 'invalid_input') continue;
    const turn = turns[models - 1];
    const sequence = turn?.sequence ?? port.sequence++;
    if (step.name === 'propose_facts') {
      const candidates = (turn?.raw as { input?: { candidates?: unknown } } | undefined)?.input?.candidates;
      const enumerable = Array.isArray(candidates) && candidates.length > 0 ? (candidates as unknown[]) : [{ malformedBatch: step.inputHash }];
      for (const candidate of enumerable) factAttempts.push({ sequence, candidate, gate: 'malformed_batch', readBefore: false });
    }
    if (step.name === 'propose_document_request') requestAttempts.push({ sequence, candidate: { malformedCall: step.inputHash }, gate: 'malformed_call' });
  }
  return {
    caseId: snapshot.caseId, arm: 'scripted_fake', label, completion: stopReason === 'finished' ? 'completed' : 'not_completed', stopReason,
    factAttempts, requestAttempts, acceptedFacts: port.facts.filter((attempt) => attempt.gate === 'valid').map((attempt) => attempt.candidate),
    malformedTurns: trace.filter((step) => step.kind === 'model' && step.outcome === 'invalid_output').length,
    modelCalls: trace.filter((step) => step.kind === 'model').length, toolCalls: tools.length,
    unsupportedToolAttempts: tools.filter((step) => step.name === 'unsupported_tool').length,
    unsupportedToolExecuted: tools.filter((step) => step.name === 'unsupported_tool' && step.outcome !== 'unsupported_tool').length,
    latencyMs, trace,
  };
}

/** A predeclared target that no run attempted: every target stays a miss. */
export const notAttempted = (caseId: string, label: string): ArmOutput => ({
  caseId, arm: 'scripted_fake', label, completion: 'not_completed', stopReason: 'not_attempted', factAttempts: [], requestAttempts: [], acceptedFacts: [],
  malformedTurns: 0, modelCalls: 0, toolCalls: 0, unsupportedToolAttempts: 0, unsupportedToolExecuted: 0, latencyMs: 0, trace: [],
});
