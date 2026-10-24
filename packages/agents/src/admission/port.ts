import {
  AttemptReservation, AttemptSettlement, DispatchGrant,
  type AdmissionRefusalCode, type AttemptReservationRequest, type UsageReport,
} from '@pa/contracts';

/**
 * The only way a provider may obtain permission for a Messages request. Every
 * implementation that can lead to a paid call talks to the API's admission
 * routes; there is no file or in-memory ledger fallback.
 */
export interface AdmissionPort {
  /** Idempotent for an identical `(turn, ordinal, requestHash)`. */
  reserve(request: AttemptReservationRequest): Promise<AttemptReservation>;
  /** Single use. A lost acknowledgement is reported as unknown and never retried. */
  dispatch(attemptId: string): Promise<DispatchGrant>;
  /** Frees a reservation that never received a grant. */
  release(attemptId: string): Promise<AttemptSettlement>;
  reconcile(attemptId: string, report: UsageReport): Promise<AttemptSettlement>;
  /** Billing is unknown: the full reservation stays committed. */
  unknown(attemptId: string): Promise<AttemptSettlement>;
}

/** The API refused the operation; no grant exists. */
export class AdmissionRefused extends Error {
  override name = 'AdmissionRefused';
  constructor(readonly code: AdmissionRefusalCode | 'not_authorized', message: string) {
    super(message);
  }
}

/** The outcome is unknown or the service is unreachable. Never treat it as permission. */
export class AdmissionUnavailable extends Error {
  override name = 'AdmissionUnavailable';
}

export interface HttpAdmissionOptions {
  origin: string;
  /** `Bearer <token>`: the worker service token or the evaluation admission token. */
  authorization: string;
  /** Route prefix for this run, for example the worker's run-and-job scope. */
  base: string;
  /** Transient retries for idempotent operations; dispatch is never retried. */
  maxRetries?: number;
  timeoutMs?: number;
}

type Schema<T> = { parse(value: unknown): T };

/**
 * HTTP client for the API admission routes. Reservation, release, usage and
 * unknown reports are idempotent on the server and retried on transport
 * failure; the dispatch transition is sent once, and any doubt about its
 * outcome becomes `AdmissionUnavailable`.
 */
export function httpAdmissionPort(options: HttpAdmissionOptions): AdmissionPort {
  const maxRetries = options.maxRetries ?? 2;
  async function post<T>(path: string, body: unknown, schema: Schema<T>, retries: number): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      let response: Response;
      try {
        response = await fetch(new URL(`${options.base}${path}`, options.origin), {
          method: 'POST', body: JSON.stringify(body),
          headers: { authorization: options.authorization, 'content-type': 'application/json' },
          signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
        });
      } catch {
        continue;
      }
      const payload: unknown = await response.json().catch(() => null);
      if (response.ok) return schema.parse(payload);
      if (response.status === 409 || response.status === 403 || response.status === 404) {
        const code = (payload as { reason?: unknown } | null)?.reason;
        throw new AdmissionRefused(typeof code === 'string' ? code as AdmissionRefusalCode : 'not_authorized', `admission refused (${response.status})`);
      }
      if (response.status < 500 && response.status !== 408 && response.status !== 429) throw new AdmissionRefused('not_authorized', `admission refused (${response.status})`);
    }
    throw new AdmissionUnavailable('the admission service did not confirm the operation');
  }
  return {
    reserve: (request) => post('/attempts', request, AttemptReservation, maxRetries),
    dispatch: (attemptId) => post(`/attempts/${attemptId}/dispatch`, {}, DispatchGrant, 0),
    release: (attemptId) => post(`/attempts/${attemptId}/release`, {}, AttemptSettlement, maxRetries),
    reconcile: (attemptId, report) => post(`/attempts/${attemptId}/usage`, report, AttemptSettlement, maxRetries),
    unknown: (attemptId) => post(`/attempts/${attemptId}/unknown`, {}, AttemptSettlement, maxRetries),
  };
}
