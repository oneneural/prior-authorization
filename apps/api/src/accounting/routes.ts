import { createHash, timingSafeEqual } from 'node:crypto';

import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { usdToUnits } from '@pa/agents/admission';
import {
  AttemptReservationRequest, EVALUATION_ADMISSION_PATH, EvaluationRunRegistration, UsageReport,
  type AttemptReservation, type DispatchGrant,
} from '@pa/contracts';

import { sendError } from '../errors.js';
import { AdmissionRefusedError, LedgerUnavailable, type AccountingLedger } from './ledger.js';
import type { DispatchOwner } from './schema.js';
import { AdmissionServiceUnavailable, type LiveAdmission } from './service.js';

/**
 * Admission answers: a refusal is a definite "no grant" (409 with its
 * reason); unavailable accounting is 503 and the caller must treat any
 * in-flight outcome as unknown.
 */
export async function admissionReply(reply: FastifyReply, operation: () => unknown) {
  try {
    return reply.code(200).send(await operation());
  } catch (error) {
    if (error instanceof AdmissionRefusedError) return reply.code(409).send({ error: { code: 'admission_refused', message: error.message }, reason: error.code });
    if (error instanceof AdmissionServiceUnavailable || error instanceof LedgerUnavailable) {
      return reply.code(503).send({ error: { code: 'admission_unavailable', message: 'Live admission is unavailable' }, reason: error.reason });
    }
    throw error;
  }
}

const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new AdmissionRefusedError('unsupported_request', 'invalid admission request');
  return parsed.data;
};

export const reservation = (attempt: { attemptId: string; state: AttemptReservation['state']; reservedUnits: number }, replayed: boolean): AttemptReservation => ({
  attemptId: attempt.attemptId, state: attempt.state, reservedUnits: attempt.reservedUnits, replayed,
});
export const grant = (ledger: AccountingLedger, attemptId: string): DispatchGrant => ({ attemptId, state: 'dispatching', writerGeneration: ledger.status().writerGeneration });

/**
 * Accounting-only settlement routes shared by both callers. They stay usable
 * after a run is stopped so held spend can still be reconciled, but they never
 * grant anything.
 */
export function registerSettlementRoutes(scope: FastifyInstance, base: string, admission: LiveAdmission, ownerOf: (params: unknown) => { runId: string; owner: DispatchOwner }) {
  type Params = { Params: Record<string, string> };
  const attempt = (params: unknown) => parse(z.uuid(), (params as { attemptId?: unknown }).attemptId);
  scope.post<Params>(`${base}/attempts/:attemptId/release`, (request, reply) => admissionReply(reply, async () => {
    const { runId, owner } = ownerOf(request.params);
    return admission.settlementLedger().release(runId, attempt(request.params), owner);
  }));
  scope.post<Params>(`${base}/attempts/:attemptId/unknown`, (request, reply) => admissionReply(reply, async () => {
    const { runId, owner } = ownerOf(request.params);
    return admission.settlementLedger().markUnknown(runId, attempt(request.params), owner);
  }));
  scope.post<Params>(`${base}/attempts/:attemptId/usage`, (request, reply) => admissionReply(reply, async () => {
    const { runId, owner } = ownerOf(request.params);
    return admission.settlementLedger().reconcile(runId, attempt(request.params), parse(UsageReport, request.body), owner);
  }));
}

const digest = (value: string) => createHash('sha256').update(value).digest();
const RunParam = z.string().regex(/^eval-[0-9a-f-]{36}$/);

/**
 * Bounded admission for the live evaluation command. It is a separate caller
 * with its own token: it registers capped budget runs and obtains attempts
 * through the same ledger mutex and single-dispatch limit as the worker, with
 * no case authority, data access or tool execution.
 */
export function registerEvaluationAdmissionRoutes(app: FastifyInstance, deps: { admission: LiveAdmission; token: string | null }) {
  if (deps.token === null) return;
  const expected = digest(deps.token);
  const base = `${EVALUATION_ADMISSION_PATH}/runs/:runId`;
  const ownerOf = (params: unknown) => {
    const runId = parse(RunParam, (params as { runId?: unknown }).runId);
    return { runId, owner: { kind: 'evaluation' as const, id: runId } };
  };
  void app.register((scope, _options, done) => {
    scope.addHook('onRequest', async (request, reply) => {
      const match = /^Bearer (\S+)$/.exec(request.headers.authorization ?? '');
      if (match === null || !timingSafeEqual(digest(match[1]!), expected)) return sendError(reply, 401, 'unauthorized', 'A valid evaluation admission token is required');
    });
    scope.post(`${EVALUATION_ADMISSION_PATH}/runs`, (request, reply) => admissionReply(reply, async () => {
      const input = parse(EvaluationRunRegistration, request.body);
      let capUnits: number;
      try { capUnits = usdToUnits(input.capUsd); } catch { throw new AdmissionRefusedError('unsupported_request', 'invalid run cap'); }
      const ledger = deps.admission.ledger();
      const run = await ledger.registerRun({
        runId: `eval-${input.registrationId}`, callerKind: 'evaluation', capUnits, versions: input.versions, binding: null, suiteDigest: input.suiteDigest, parentRunId: null,
      });
      return ledger.runSummary(run.runId);
    }));
    scope.get(base, (request, reply) => admissionReply(reply, () => {
      const summary = deps.admission.settlementLedger().runSummary(ownerOf(request.params).runId);
      if (summary === null) throw new AdmissionRefusedError('run_stopped', 'the run is not registered');
      return summary;
    }));
    scope.post(`${base}/stop`, (request, reply) => admissionReply(reply, async () => {
      const { runId } = ownerOf(request.params);
      await deps.admission.settlementLedger().stopRun(runId, 'evaluation_finished');
      return deps.admission.settlementLedger().runSummary(runId);
    }));
    scope.post(`${base}/attempts`, (request, reply) => admissionReply(reply, async () => {
      const { runId, owner } = ownerOf(request.params);
      const result = await deps.admission.ledger().reserve(runId, parse(AttemptReservationRequest, request.body), owner);
      return reservation(result.attempt, result.replayed);
    }));
    scope.post(`${base}/attempts/:attemptId/dispatch`, (request, reply) => admissionReply(reply, async () => {
      const { runId, owner } = ownerOf(request.params);
      const ledger = deps.admission.ledger();
      const attemptId = parse(z.uuid(), (request.params as { attemptId?: unknown }).attemptId);
      await ledger.dispatch(runId, attemptId, owner);
      return grant(ledger, attemptId);
    }));
    registerSettlementRoutes(scope, base, deps.admission, ownerOf);
    done();
  });
}
