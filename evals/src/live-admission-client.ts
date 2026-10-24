import { randomUUID } from 'node:crypto';

import { AdmissionRefused, AdmissionUnavailable, httpAdmissionPort, type AdmissionPort } from '@pa/agents';
import { BudgetRunSummary, EVALUATION_ADMISSION_PATH, type RunVersionsRecord } from '@pa/contracts';

/**
 * The live evaluation command's only route to spend: the API's bounded
 * evaluation admission operations. It holds no ledger and has no fallback;
 * an unreachable API means no live call.
 */
export interface EvaluationAdmission { origin: string; authorization: string }

async function call(admission: EvaluationAdmission, method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
  // Registration is idempotent by its registration ID, so a transport failure is retried with the same body.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    let response: Response;
    try {
      response = await fetch(new URL(`${EVALUATION_ADMISSION_PATH}${path}`, admission.origin), {
        method, headers: { authorization: admission.authorization, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000),
      });
    } catch {
      continue;
    }
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return payload;
    if (response.status === 409) throw new AdmissionRefused(((payload as { reason?: string } | null)?.reason ?? 'not_authorized') as never, 'evaluation admission refused');
    if (response.status < 500) throw new AdmissionRefused('not_authorized', `evaluation admission refused (${response.status})`);
  }
  throw new AdmissionUnavailable('the evaluation admission service did not confirm the operation');
}

export type RegisteredRun = BudgetRunSummary;

/** Registers one capped budget run; the API freezes the smaller of the requested cap and policy. */
export async function registerEvaluationRun(admission: EvaluationAdmission, input: { capUsd: string; suiteDigest: string; versions: RunVersionsRecord; registrationId?: string }): Promise<RegisteredRun> {
  const payload = await call(admission, 'POST', '/runs', { registrationId: input.registrationId ?? randomUUID(), capUsd: input.capUsd, suiteDigest: input.suiteDigest, versions: input.versions });
  return BudgetRunSummary.parse(payload);
}

export async function evaluationRunSummary(admission: EvaluationAdmission, runId: string): Promise<BudgetRunSummary> {
  return BudgetRunSummary.parse(await call(admission, 'GET', `/runs/${runId}`));
}

/** Fences the run once the command finishes; held spend can still be reconciled. */
export async function stopEvaluationRun(admission: EvaluationAdmission, runId: string): Promise<BudgetRunSummary> {
  return BudgetRunSummary.parse(await call(admission, 'POST', `/runs/${runId}/stop`, {}));
}

/**
 * Attempt admission for one registered run. Each case's provider counts turns
 * from zero, so attempts are numbered across the whole run: every attempt gets
 * a distinct identity, and a retried lost acknowledgement reuses its own.
 */
export function sequencedAdmission(port: AdmissionPort): AdmissionPort {
  let next = 0;
  return { ...port, reserve: (request) => port.reserve({ ...request, turn: next++ }) };
}

export function evaluationAdmissionPort(admission: EvaluationAdmission, runId: string): AdmissionPort {
  return sequencedAdmission(httpAdmissionPort({ origin: admission.origin, authorization: admission.authorization, base: `${EVALUATION_ADMISSION_PATH}/runs/${runId}` }));
}
