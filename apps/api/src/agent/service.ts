import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import { and, eq } from 'drizzle-orm';

import type { AgentSettings } from '@pa/agents/config';
import { createRecordedProvider, LIVE_MODEL_DEFAULTS, liveProviderVersion, liveRunVersionsRecord, loadRecording, runVersions } from '@pa/agents/versions';
import { assessmentInput, validateSnapshot } from '@pa/connectors';
import {
  AGENT_QUEUE, CASE_NOTICE, DocumentExact, EVIDENCE_FIELD_SOURCES, EvidenceFactV2, FactProposal, ModelFactCandidate, ModelRequestCandidate, RequestProposal,
  type AgentCompletionReport, type AgentProposalResult, type CancelAgentRunCommand, type AgentProposalSubmission, type AgentReviewCommand, type AgentRunFailure,
  type AgentRunReport, type AgentRunScope, type ProposalRejection, type RevisionBinding, type SessionActor, type StartAgentRunCommand,
} from '@pa/contracts';
import {
  agentProposals, agentRuns, enqueueAgentJob, findAgentRun, findCase, listAgentProposals, listCaseAgentRuns, lockAgentRun, readCaseSnapshot,
  type AgentRunRow, type Database, type PgBoss,
} from '@pa/db';
import { assessV2 } from '@pa/domain';

import { AdmissionRefusedError, sha256 } from '../accounting/ledger.js';
import type { LiveAdmission } from '../accounting/service.js';
import { authorizedCase, CaseError, currentAssessment, event, isWithheld, sourceAt } from '../cases/service.js';
import { command, payloadHash, proposeRequest, revisionBinding } from '../workflow/service.js';
import { requestTemplate } from '../workflow/templates.js';

/** A requested capability this deployment keeps off; the route returns it with the capability state. */
export class AgentCapabilityDisabled extends Error {
  constructor(readonly code: 'live_provider_disabled' | 'agent_graph_disabled' | 'accounting_unavailable' | 'cap_below_attempt_ceiling', message: string) { super(message); }
}

const conflict = (message: string) => new CaseError(409, message);
const LIVE_VERSIONS = runVersions(liveProviderVersion(LIVE_MODEL_DEFAULTS));

/** Fences a live run in the ledger. Best effort where the database outcome is already final. */
async function stopBudgetRun(admission: LiveAdmission, runId: string, reason: string) {
  if (!admission.live) return;
  await admission.settlementLedger().stopRun(runId, reason);
}

/**
 * A live run is admitted only in live mode with open accounting. Its budget
 * run is registered in the canonical ledger inside the same command, so a
 * failed registration leaves no queued run.
 */
async function startLiveRun(db: Database, boss: PgBoss, admission: LiveAdmission, actor: SessionActor, caseId: string, input: StartAgentRunCommand) {
  if (!admission.live) throw new AgentCapabilityDisabled('live_provider_disabled', 'Live Claude is not enabled in this deployment');
  if (admission.reason === 'cap_below_attempt_ceiling') throw new AgentCapabilityDisabled('cap_below_attempt_ceiling', 'A configured live cap is below one attempt reservation, so live runs are refused');
  if (admission.reason !== null) throw new AgentCapabilityDisabled('accounting_unavailable', 'Live accounting is unavailable, so live runs are refused');
  if (input.recordingId !== undefined) throw new CaseError(400, 'a live run takes no recording');
  return command(db, actor, caseId, 'agent_run_queued', input, async (tx, head) => {
    if (head.state === 'cancelled') throw conflict('cancelled cases are terminal');
    if (head.revision !== input.expectedRevision) throw conflict('case revision no longer current');
    const binding = await revisionBinding(tx, head);
    const runId = randomUUID();
    const jobId = randomUUID();
    await tx.insert(agentRuns).values({
      runId, caseId, caseRevision: head.revision, binding, provider: 'anthropic', label: 'live_claude', recordingId: null,
      versions: LIVE_VERSIONS, threadId: `agent-${runId}`, state: 'queued', pendingJobId: jobId,
    });
    try {
      await admission.ledger().registerRun({
        runId, callerKind: 'packaged', capUnits: admission.settings.live.runUnits, versions: liveRunVersionsRecord(LIVE_VERSIONS.provider, admission.build),
        binding: { caseId, bindingHash: sha256(JSON.stringify(binding)) }, suiteDigest: null, parentRunId: null,
      });
    } catch (error) {
      if (error instanceof AdmissionRefusedError) throw new AgentCapabilityDisabled('accounting_unavailable', 'Live accounting refused the run');
      throw error;
    }
    await enqueueAgentJob(boss, tx, jobId, { runId, phase: 'start' });
    return { runId, state: 'queued', label: 'live_claude' };
  });
}

export async function startAgentRun(db: Database, boss: PgBoss, settings: AgentSettings, admission: LiveAdmission, actor: SessionActor, caseId: string, input: StartAgentRunCommand) {
  // Refused before any recording, key, client or budget lookup unless live mode was selected explicitly.
  if (input.provider === 'anthropic') return startLiveRun(db, boss, admission, actor, caseId, input);
  if (settings.graphProvider === 'off') throw new AgentCapabilityDisabled('agent_graph_disabled', 'Recorded investigation runs are not enabled');
  if (input.recordingId === undefined) throw new CaseError(400, 'a recording is required for a recorded run');
  const versions = runVersions(createRecordedProvider(await loadRecording(input.recordingId).catch(() => { throw new CaseError(400, 'recording unavailable'); })).version);
  return command(db, actor, caseId, 'agent_run_queued', input, async (tx, head) => {
    if (head.state === 'cancelled') throw conflict('cancelled cases are terminal');
    if (head.revision !== input.expectedRevision) throw conflict('case revision no longer current');
    const binding = await revisionBinding(tx, head);
    const runId = randomUUID();
    const jobId = randomUUID();
    await tx.insert(agentRuns).values({
      runId, caseId, caseRevision: head.revision, binding, provider: 'recorded', label: 'scripted_fixture', recordingId: input.recordingId!,
      versions, threadId: `agent-${runId}`, state: 'queued', pendingJobId: jobId,
    });
    await enqueueAgentJob(boss, tx, jobId, { runId, phase: 'start' });
    return { runId, state: 'queued', label: 'scripted_fixture' };
  });
}

/** The active queue job and the persisted run are the only sources of scope. */
async function activeRun(db: Database, boss: PgBoss, runId: string, jobId: string, states: readonly string[]): Promise<AgentRunRow> {
  const job = await boss.getJobById(AGENT_QUEUE, jobId);
  const run = await findAgentRun(db, runId);
  if (job?.state !== 'active' || (job.data as { runId?: unknown }).runId !== runId || run?.pendingJobId !== jobId || !states.includes(run.state)) throw conflict('agent job not active for this run');
  return run;
}

/** A live investigation that was already running cannot be reconstructed: it stops before the review boundary. */
async function stopInterruptedLiveRun(tx: Parameters<Parameters<Database['transaction']>[0]>[0], run: AgentRunRow) {
  await tx.update(agentRuns).set({ state: 'failed', failureCode: 'interrupted_before_review', pendingJobId: null, updatedAt: new Date() }).where(eq(agentRuns.runId, run.runId));
  await event(tx, run.caseId, run.caseRevision, 'agent_run_failed:interrupted_before_review', { runId: run.runId, code: 'interrupted_before_review' }, run.runId, 'agent-worker');
}

export async function claimAgentJob(db: Database, boss: PgBoss, admission: LiveAdmission, runId: string, jobId: string, claimId: string): Promise<AgentRunScope> {
  await activeRun(db, boss, runId, jobId, ['queued', 'running', 'resume_queued', 'resuming']);
  const interrupted = await db.transaction(async (tx) => {
    const run = await lockAgentRun(tx, runId);
    if (run?.pendingJobId !== jobId) throw conflict('agent job not active for this run');
    // The same claim repeated (its response was lost) is a retry of a healthy run; any
    // other claim of a running live job is a redelivery after an interruption.
    if (run.provider === 'anthropic' && run.state === 'running' && run.claimId !== claimId) {
      await stopInterruptedLiveRun(tx, run);
      return true;
    }
    return false;
  });
  if (interrupted) {
    await stopBudgetRun(admission, runId, 'interrupted_before_review').catch(() => undefined);
    throw conflict('an interrupted live run stops safely; start a fresh run');
  }
  return db.transaction(async (tx) => {
    const run = await lockAgentRun(tx, runId);
    if (run?.pendingJobId !== jobId) throw conflict('agent job not active for this run');
    const phase = run.state === 'queued' || run.state === 'running' ? 'start' : 'resume';
    await tx.update(agentRuns).set({ state: phase === 'start' ? 'running' : 'resuming', claimId, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    return {
      runId, caseId: run.caseId, revision: run.caseRevision, binding: run.binding, threadId: run.threadId, phase,
      provider: run.provider as AgentRunScope['provider'], recordingId: run.recordingId, versions: run.versions, reviewEventId: run.reviewEventId,
    };
  });
}

/** Current binding for the run's revision, or null when the case moved on or has no current packet. */
async function currentBinding(db: Database, run: AgentRunRow): Promise<RevisionBinding | null> {
  const head = await findCase(db, run.caseId);
  if (head?.revision !== run.caseRevision) return null;
  return revisionBinding(db, head).catch((error: unknown) => { if (error instanceof CaseError) return null; throw error; });
}

async function scopedSources(db: Database, run: AgentRunRow) {
  if (!isDeepStrictEqual(await currentBinding(db, run), run.binding)) throw conflict('run inputs are no longer current');
  const assessment = await currentAssessment(db, run.caseId, run.caseRevision);
  const snapshot = await readCaseSnapshot(db, run.caseId, run.caseRevision);
  if (assessment?.outcome?.outcome !== 'assessed' || snapshot === undefined) throw conflict('source classification pending');
  return { outcome: assessment.outcome, snapshot };
}

export async function agentDocuments(db: Database, boss: PgBoss, runId: string, jobId: string) {
  const { outcome, snapshot } = await scopedSources(db, await activeRun(db, boss, runId, jobId, ['running']));
  return {
    documents: snapshot.documents.map((doc) => {
      const meta = DocumentExact.parse(JSON.parse(doc.metadataText));
      const readable = doc.payload !== null && meta.accessStatus === 'available' && !isWithheld(outcome, meta.documentId, meta.version);
      return { documentId: meta.documentId, version: meta.version, kind: meta.kind, accessStatus: meta.accessStatus, readable, contentHash: readable ? meta.contentHash : null };
    }),
  };
}

export async function agentReadDocument(db: Database, boss: PgBoss, runId: string, jobId: string, documentId: string, version: number) {
  const { outcome, snapshot } = await scopedSources(db, await activeRun(db, boss, runId, jobId, ['running']));
  if (isWithheld(outcome, documentId, version)) throw new CaseError(404, 'case resource unavailable');
  const source = sourceAt(snapshot, documentId, version) as { metadata: DocumentExact; payload: string };
  return { documentId, version, kind: source.metadata.kind, contentHash: source.metadata.contentHash, payload: source.payload };
}

/** A bounded summary: pack identity and the current findings, never the whole pack text. */
export async function agentPolicy(db: Database, boss: PgBoss, runId: string, jobId: string) {
  const { outcome } = await scopedSources(db, await activeRun(db, boss, runId, jobId, ['running']));
  return {
    policyPackId: outcome.result.policyPackId, policyPackSha256: outcome.result.policyPackSha256,
    findings: outcome.result.findings.map((finding) => ({ findingId: finding.findingId, ruleId: finding.ruleId, status: finding.status, conditionKeys: finding.conditions.map((item) => item.conditionKey) })),
  };
}

async function validateFact(db: Database, run: AgentRunRow, candidate: unknown, minConfidence: number, proposalId: string): Promise<{ code: ProposalRejection | null; payload: FactProposal | null }> {
  const parsed = ModelFactCandidate.safeParse(candidate);
  if (!parsed.success) return { code: 'invalid_schema', payload: null };
  const item = parsed.data;
  let sources;
  try { sources = await scopedSources(db, run); } catch { return { code: 'binding_stale', payload: null }; }
  if (isWithheld(sources.outcome, item.documentId, item.documentVersion)) return { code: 'source_unavailable', payload: null };
  let metadata: DocumentExact;
  let resolved;
  try {
    metadata = (sourceAt(sources.snapshot, item.documentId, item.documentVersion) as { metadata: DocumentExact }).metadata;
    if (metadata.contentHash !== item.sourceContentHash) return { code: 'source_hash_mismatch', payload: null };
    const source = EVIDENCE_FIELD_SOURCES[item.field];
    if (source.documentKind !== metadata.kind || source.pointer !== item.locator) return { code: 'locator_mismatch', payload: null };
    resolved = sourceAt(sources.snapshot, item.documentId, item.documentVersion, item.locator) as { value: unknown; originalText: string };
  } catch (error) {
    if (error instanceof CaseError) return { code: error.statusCode === 409 ? 'source_hash_mismatch' : 'source_unavailable', payload: null };
    throw error;
  }
  if (resolved.value !== item.value || resolved.originalText !== item.originalText) return { code: 'value_mismatch', payload: null };
  const fact = EvidenceFactV2.safeParse({
    schemaVersion: 'pa.evidence-fact.v2', factId: `agent-${proposalId}`, field: item.field, value: item.value, documentId: item.documentId,
    documentVersion: item.documentVersion, locator: item.locator, originalText: item.originalText, extractionMethod: 'model', confidence: item.confidence, reviewStatus: 'proposed',
  });
  if (!fact.success) return { code: 'value_mismatch', payload: null };
  const payload = FactProposal.parse({ ...run.binding, fact: fact.data, sourceContentHash: item.sourceContentHash });
  // Recorded with its payload for review, but never acceptable.
  if (item.confidence < minConfidence) return { code: 'low_confidence', payload };
  return { code: null, payload };
}

async function validateRequest(db: Database, run: AgentRunRow, candidate: unknown): Promise<{ code: ProposalRejection | null; payload: RequestProposal | null }> {
  const parsed = ModelRequestCandidate.safeParse(candidate);
  if (!parsed.success) return { code: 'invalid_schema', payload: null };
  let outcome;
  try { outcome = (await scopedSources(db, run)).outcome; } catch { return { code: 'binding_stale', payload: null }; }
  const payload = RequestProposal.parse({ ...run.binding, ...parsed.data });
  try {
    requestTemplate(payload, outcome.result.findings.find((finding) => finding.findingId === payload.findingId));
  } catch (error) {
    if (error instanceof CaseError) return { code: 'request_not_applicable', payload: null };
    throw error;
  }
  return { code: null, payload };
}

/** Keyed by run and proposal key, so a rerun graph node records each proposal once. */
export async function recordProposal(db: Database, boss: PgBoss, settings: AgentSettings, runId: string, jobId: string, submission: AgentProposalSubmission): Promise<AgentProposalResult> {
  const run = await activeRun(db, boss, runId, jobId, ['running']);
  const hash = payloadHash({ kind: submission.kind, candidate: submission.candidate ?? null });
  const previous = (await db.select().from(agentProposals).where(and(eq(agentProposals.runId, runId), eq(agentProposals.proposalKey, submission.proposalKey))))[0];
  if (previous !== undefined) {
    if (previous.payloadHash !== hash) throw conflict('proposal key reused with changed payload');
    return { proposalId: previous.proposalId, status: previous.status as AgentProposalResult['status'], code: previous.code as ProposalRejection | null };
  }
  const proposalId = randomUUID();
  const { code, payload } = submission.kind === 'fact' ? await validateFact(db, run, submission.candidate, settings.minConfidence, proposalId) : await validateRequest(db, run, submission.candidate);
  const status = code === null ? 'valid' : 'rejected';
  const [row] = await db.insert(agentProposals).values({ proposalId, runId, proposalKey: submission.proposalKey, kind: submission.kind, payload, payloadHash: hash, status, code })
    .onConflictDoNothing().returning();
  if (row === undefined) return recordProposal(db, boss, settings, runId, jobId, submission);
  return { proposalId, status, code };
}

/**
 * Reserve and dispatch need the active job, a live run and inputs that are
 * still current. A stale binding fences the budget run before refusing.
 */
export async function liveAttemptScope(db: Database, boss: PgBoss, admission: LiveAdmission, runId: string, jobId: string): Promise<AgentRunRow> {
  let run: AgentRunRow;
  try {
    run = await activeRun(db, boss, runId, jobId, ['running']);
  } catch {
    throw new AdmissionRefusedError('run_stopped', 'the run has no active investigation job');
  }
  if (run.provider !== 'anthropic') throw new AdmissionRefusedError('attempt_conflict', 'only live runs request model attempts');
  if (!isDeepStrictEqual(await currentBinding(db, run), run.binding)) {
    await stopBudgetRun(admission, runId, 'binding_stale');
    throw new AdmissionRefusedError('binding_stale', 'run inputs are no longer current');
  }
  return run;
}

/** API startup: a live run left `running` by a previous process stops safely instead of resuming mid-investigation. */
export async function stopInterruptedLiveRuns(db: Database, admission: LiveAdmission): Promise<number> {
  const stranded = await db.select().from(agentRuns).where(and(eq(agentRuns.provider, 'anthropic'), eq(agentRuns.state, 'running')));
  for (const candidate of stranded) {
    await db.transaction(async (tx) => {
      const run = await lockAgentRun(tx, candidate.runId);
      if (run?.provider === 'anthropic' && run.state === 'running') await stopInterruptedLiveRun(tx, run);
    });
    await stopBudgetRun(admission, candidate.runId, 'interrupted_before_review').catch(() => undefined);
  }
  return stranded.length;
}

/** The graph reached its human review interrupt: release the job and wait. */
export async function recordAwaitingReview(db: Database, boss: PgBoss, admission: LiveAdmission, runId: string, report: AgentRunReport) {
  const active = await activeRun(db, boss, runId, report.jobId, ['running']);
  const identity = report.modelIdentity;
  if (active.provider === 'anthropic') {
    if (identity.provider !== 'anthropic' || identity.label !== 'live_claude' || identity.model !== LIVE_MODEL_DEFAULTS.model) throw conflict('model identity does not match the live run');
    // Every attempt must be settled or held before the review boundary, then the budget run is fenced.
    if (admission.settlementLedger().hasActiveDispatch(runId)) throw conflict('a model attempt for this run is still in flight');
    await stopBudgetRun(admission, runId, 'awaiting_review');
  } else if (identity.provider !== 'recorded' || identity.label !== 'scripted_fixture') {
    throw conflict('model identity does not match the recorded run');
  }
  return db.transaction(async (tx) => {
    const run = await lockAgentRun(tx, runId);
    if (run?.pendingJobId !== report.jobId || run.state !== 'running') throw conflict('agent job not active for this run');
    await tx.update(agentRuns).set({ state: 'awaiting_review', pendingJobId: null, trace: report.trace, stopReason: report.stopReason, modelIdentity: report.modelIdentity, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    await event(tx, run.caseId, run.caseRevision, 'agent_run_awaiting_review', { runId, stopReason: report.stopReason }, runId, 'agent-worker');
    return { state: 'awaiting_review' };
  });
}

/** The reviewer is the signed-in session actor. Acceptance still waits for a fresh input check. */
export async function reviewAgentRun(db: Database, boss: PgBoss, actor: SessionActor, caseId: string, runId: string, input: AgentReviewCommand) {
  return command(db, actor, caseId, `agent_reviewed:${runId}`, input, async (tx, head) => {
    if (head.state === 'cancelled') throw conflict('cancelled cases are terminal');
    const run = await lockAgentRun(tx, runId);
    if (run?.caseId !== caseId) throw new CaseError(404, 'agent run unavailable');
    if (run.state !== 'awaiting_review') throw conflict('agent run is not awaiting review');
    const proposals = await listAgentProposals(tx, runId);
    for (const decision of input.decisions) {
      const proposal = proposals.find((item) => item.proposalId === decision.proposalId);
      if (proposal === undefined) throw new CaseError(404, 'proposal unavailable');
      if (decision.decision === 'accept' && proposal.status !== 'valid') throw conflict('only validated proposals can be accepted');
      await tx.update(agentProposals).set({ review: decision.decision === 'accept' ? 'accept_requested' : 'rejected' }).where(eq(agentProposals.proposalId, proposal.proposalId));
    }
    const jobId = randomUUID();
    await tx.update(agentRuns).set({ state: 'resume_queued', reviewEventId: input.eventId, pendingJobId: jobId, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    await enqueueAgentJob(boss, tx, jobId, { runId, phase: 'resume' });
    return { runId, state: 'resume_queued' };
  });
}

export async function agentInputs(db: Database, boss: PgBoss, runId: string, jobId: string) {
  const run = await activeRun(db, boss, runId, jobId, ['resuming']);
  const head = await findCase(db, run.caseId);
  return { revision: head!.revision, binding: await currentBinding(db, run) };
}

/**
 * Applies accepted proposals only when the run's case, source, policy and packet
 * revisions are still current. A fact is accepted as a reviewed candidate; it
 * never replaces the deterministic assessment, which is rerun for comparison.
 * A request becomes an ordinary draft that still needs explicit approval.
 */
export async function completeAgentRun(db: Database, boss: PgBoss, runId: string, report: AgentCompletionReport) {
  const run = await activeRun(db, boss, runId, report.jobId, ['resuming']);
  const unchanged = isDeepStrictEqual(await currentBinding(db, run), run.binding);
  const requested = (await listAgentProposals(db, runId)).filter((item) => item.review === 'accept_requested');
  const reviews = new Map<string, 'accepted' | 'stale'>();
  const draftedRequests: string[] = [];
  for (const proposal of requested) {
    if (!unchanged) { reviews.set(proposal.proposalId, 'stale'); continue; }
    if (proposal.kind === 'request') {
      try {
        const created = await proposeRequest(db, null, run.caseId, { ...RequestProposal.parse(proposal.payload), eventId: proposal.proposalId, idempotencyKey: `agent-${proposal.proposalId}` });
        draftedRequests.push((created as { request: { requestId: string } }).request.requestId);
      } catch (error) {
        if (!(error instanceof CaseError)) throw error;
        reviews.set(proposal.proposalId, 'stale');
        continue;
      }
    }
    reviews.set(proposal.proposalId, 'accepted');
  }
  let ruleComparison: { proposalId: string; matchesRules: boolean }[] = [];
  if (unchanged) {
    const snapshot = (await readCaseSnapshot(db, run.caseId, run.caseRevision))!;
    const rules = await assessV2(assessmentInput(validateSnapshot(snapshot)));
    const facts = rules.outcome === 'assessed' ? rules.result.evidenceFacts : [];
    ruleComparison = requested.filter((item) => item.kind === 'fact' && reviews.get(item.proposalId) === 'accepted').map((item) => {
      const fact = FactProposal.parse(item.payload).fact;
      return { proposalId: item.proposalId, matchesRules: facts.some((rule) => rule.field === fact.field && rule.documentId === fact.documentId && rule.documentVersion === fact.documentVersion && rule.value === fact.value) };
    });
  }
  return db.transaction(async (tx) => {
    const locked = await lockAgentRun(tx, runId);
    if (locked?.pendingJobId !== report.jobId || locked.state !== 'resuming') throw conflict('agent job not active for this run');
    for (const [proposalId, review] of reviews) await tx.update(agentProposals).set({ review }).where(eq(agentProposals.proposalId, proposalId));
    const outcome = {
      inputsChanged: !unchanged, workerReportedInputsChanged: report.inputsChanged, draftedRequests, ruleComparison,
      accepted: [...reviews.values()].filter((value) => value === 'accepted').length, stale: [...reviews.values()].filter((value) => value === 'stale').length,
    };
    await tx.update(agentRuns).set({ state: 'completed', pendingJobId: null, trace: report.trace, outcome, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    await event(tx, run.caseId, run.caseRevision, 'agent_run_completed', { runId, ...outcome }, runId, 'agent-worker');
    return { state: 'completed', ...outcome };
  });
}

export async function failAgentRun(db: Database, boss: PgBoss, admission: LiveAdmission, runId: string, report: AgentRunFailure) {
  const active = await activeRun(db, boss, runId, report.jobId, ['running', 'resuming']);
  if (active.provider === 'anthropic') await stopBudgetRun(admission, runId, `failed:${report.code}`).catch(() => undefined);
  return db.transaction(async (tx) => {
    const run = await lockAgentRun(tx, runId);
    if (run?.pendingJobId !== report.jobId) throw conflict('agent job not active for this run');
    await tx.update(agentRuns).set({ state: 'failed', failureCode: report.code, pendingJobId: null, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    await event(tx, run.caseId, run.caseRevision, `agent_run_failed:${report.code}`, { runId, code: report.code }, runId, 'agent-worker');
    return { state: 'failed', code: report.code };
  });
}

/**
 * Operator recovery for a run left in flight, for example after its status
 * report or claim failed. The pending job is detached, so any later worker
 * report for it is refused; proposals stay recorded but can no longer be reviewed.
 */
export async function cancelAgentRun(db: Database, admission: LiveAdmission, actor: SessionActor, caseId: string, runId: string, input: CancelAgentRunCommand) {
  const result = await command(db, actor, caseId, `agent_run_cancelled:${runId}`, input, async (tx) => {
    const run = await lockAgentRun(tx, runId);
    if (run?.caseId !== caseId) throw new CaseError(404, 'agent run unavailable');
    if (['completed', 'failed', 'cancelled'].includes(run.state)) throw conflict('agent run already finished');
    await tx.update(agentRuns).set({ state: 'cancelled', pendingJobId: null, updatedAt: new Date() }).where(eq(agentRuns.runId, runId));
    return { runId, state: 'cancelled', provider: run.provider };
  });
  // The detached job already fails every reserve and dispatch check; the ledger fence makes it explicit.
  if ((result as { provider?: string }).provider === 'anthropic') await stopBudgetRun(admission, runId, 'cancelled').catch(() => undefined);
  return { runId, state: 'cancelled' };
}

export async function agentRunView(db: Database, actor: SessionActor, caseId: string, runId: string) {
  await authorizedCase(db, caseId, actor);
  const run = await findAgentRun(db, runId);
  if (run?.caseId !== caseId) throw new CaseError(404, 'agent run unavailable');
  const { runId: id, state, label, provider, recordingId, caseRevision, versions, stopReason, failureCode, modelIdentity, trace, outcome, createdAt, updatedAt } = run;
  const proposals = (await listAgentProposals(db, runId)).map(({ proposalId, kind, status, code, review, payload }) => ({ proposalId, kind, status, code, review, payload }));
  return { notice: CASE_NOTICE, run: { runId: id, state, label, provider, recordingId, caseRevision, versions, stopReason, failureCode, modelIdentity, trace, outcome, createdAt, updatedAt }, proposals };
}

/** Run summaries for the case panel, newest first. Proposals are read per run. */
export async function listAgentRunsView(db: Database, actor: SessionActor, caseId: string) {
  await authorizedCase(db, caseId, actor);
  const runs = await listCaseAgentRuns(db, caseId);
  return { notice: CASE_NOTICE, runs: runs.map(({ runId, state, label, provider, recordingId, caseRevision, stopReason, failureCode, outcome, createdAt, updatedAt }) => ({ runId, state, label, provider, recordingId, caseRevision, stopReason, failureCode, outcome, createdAt, updatedAt })) };
}
