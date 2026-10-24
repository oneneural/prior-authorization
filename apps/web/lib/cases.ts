import { cookies } from 'next/headers';
import { notFound, redirect } from 'next/navigation';

import { API_ORIGIN } from '@pa/config/topology';
import type {
  AgentCapability, AssessmentOutcomeV3, CasePacket, DocumentExact, IntakeCaseV2, RevisionBinding, SessionView,
} from '@pa/contracts';

import { SESSION_COOKIE } from './upstream';

// Server Component reads. The browser never calls the API directly: these run on
// the web server with only the caller's session cookie, and the API enforces
// session, role and case scope on every read.

export interface CaseRow {
  caseId: string; ownerId: string; revision: number; state: string; currentJobId: string | null;
  itemCode: string | null; requestKind: string | null; outstandingIssues: number | null; clinicalQuestions: number | null; lastEvidenceUpdate: string | null;
}
export interface CaseDetail {
  caseId: string; ownerId: string; revision: number; state: string; currentJobId: string | null;
  record: IntakeCaseV2; assessment: AssessmentOutcomeV3 | null;
}
export interface RequestRow {
  requestId: string; caseRevision: number; findingId: string; ruleId: string; state: string; contentHash: string;
  payload: RevisionBinding & { findingId: string; templateId: string; recipientRole: string; body: string; caseId: string };
  approvedBy: string | null; approvedAt: string | null;
}
export interface WorkflowView {
  head: { state: string; revision: number };
  binding: RevisionBinding | null;
  requests: RequestRow[];
  receipts: { receiptId: string; requestId: string; contentHash: string; mode: string; deliveredAt: string }[];
  packets: { packet: CasePacket; superseded: boolean }[];
  decisions: { decisionId: string; actorId: string; role: string; decision: string; reason: string; binding: RevisionBinding; createdAt: string }[];
  responses: { eventId: string; disposition: string; fixtureEvent: string }[];
}
export interface AgentRunSummary { runId: string; state: string; label: string; provider: string; recordingId: string | null; caseRevision: number; stopReason: string | null; failureCode: string | null; createdAt: string }
export interface AgentProposalView {
  proposalId: string; kind: 'fact' | 'request'; status: 'valid' | 'rejected'; code: string | null; review: string;
  payload: null | { fact?: { field: string; value: unknown; documentId: string; documentVersion: number; locator: string; originalText: string; confidence: number | null }; findingId?: string; templateId?: string; recipientRole?: string };
}
export interface AgentRunDetail { run: AgentRunSummary & { outcome: Record<string, unknown> | null }; proposals: AgentProposalView[] }

async function call(path: string): Promise<Response> {
  const cookie = (await cookies()).getAll().filter((entry) => SESSION_COOKIE.test(entry.name)).map((entry) => `${entry.name}=${entry.value}`).join('; ');
  return fetch(new URL(path, API_ORIGIN), { headers: cookie === '' ? {} : { cookie }, cache: 'no-store' });
}

/** A scoped read: no session goes to login, an unknown or out-of-scope case is a 404. */
export async function load<T>(path: string): Promise<T> {
  const response = await call(path);
  if (response.status === 401) redirect('/login');
  if (response.status === 404) notFound();
  if (!response.ok) throw new Error(`API read failed with ${response.status}`);
  return (await response.json()) as T;
}

/** For reads whose unavailability is a normal state (for example a packet still pending). */
export async function loadOptional<T>(path: string): Promise<{ ok: true; body: T } | { ok: false; status: number; message: string }> {
  const response = await call(path);
  if (response.status === 401) redirect('/login');
  if (response.ok) return { ok: true, body: (await response.json()) as T };
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  return { ok: false, status: response.status, message: body?.error?.message ?? `HTTP ${response.status}` };
}

export async function requireSession(): Promise<SessionView> {
  return load<SessionView>('/api/auth/session-actor');
}

export async function currentSession(): Promise<SessionView | null> {
  const response = await call('/api/auth/session-actor');
  return response.ok ? ((await response.json()) as SessionView) : null;
}

export const caseDetail = (caseId: string) => load<CaseDetail>(`/api/cases/${encodeURIComponent(caseId)}`);
export const caseDocuments = (caseId: string) => load<{ documents: DocumentExact[] }>(`/api/cases/${encodeURIComponent(caseId)}/documents`);
export const caseWorkflow = (caseId: string) => load<WorkflowView>(`/api/cases/${encodeURIComponent(caseId)}/workflow`);
export const agentCapability = () => load<AgentCapability>('/api/agent/capability');
export const agentRuns = (caseId: string) => load<{ runs: AgentRunSummary[] }>(`/api/cases/${encodeURIComponent(caseId)}/agent-runs`);
export const agentRun = (caseId: string, runId: string) => load<AgentRunDetail>(`/api/cases/${encodeURIComponent(caseId)}/agent-runs/${encodeURIComponent(runId)}`);
