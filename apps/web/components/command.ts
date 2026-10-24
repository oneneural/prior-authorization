import { ErrorResponse } from '@pa/contracts';

export type CommandResult = { ok: true; body: unknown } | { ok: false; status: number; code: string; message: string };

/** Posts one workbench command through the same-origin BFF. The browser adds Origin. */
export async function postCase(path: string, body: unknown): Promise<CommandResult> {
  try {
    const response = await fetch(`/api/cases/${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const payload: unknown = await response.json().catch(() => null);
    if (response.ok) return { ok: true, body: payload };
    const error = ErrorResponse.safeParse(payload);
    return { ok: false, status: response.status, code: error.success ? error.data.error.code : 'unknown', message: error.success ? error.data.error.message : `HTTP ${response.status}` };
  } catch {
    return { ok: false, status: 0, code: 'network', message: 'The web server could not be reached' };
  }
}

/** Plain-language outcome for a refused command; a 409 is always a stale or conflicting view. */
export function refusal(result: Extract<CommandResult, { ok: false }>): string {
  if (result.status === 409) return `Not recorded: this view is stale or conflicts with the current case (${result.message}). The preview stays visible; reload to review the current revision.`;
  if (result.status === 403) return `Not recorded: ${result.message}.`;
  if (result.status === 401) return 'Not recorded: your session ended. Sign in again.';
  return `Not recorded: ${result.message}. Retrying reuses the same event ID.`;
}
