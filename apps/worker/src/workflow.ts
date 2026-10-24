import { WORKFLOW_QUEUE, WORKFLOW_WORKER_PATH, WorkflowJobPayload } from '@pa/contracts';
import type { PgBoss } from '@pa/db';

export class ToolFailure extends Error {
  constructor(readonly permanent: boolean, readonly status?: number) { super(permanent ? 'permanent_tool_failure' : 'tool_retries_exhausted'); }
}

/** Initial attempt plus at most two retries. Queue retries stay disabled. */
export async function toolFetch(url: URL, options: RequestInit, fetcher: typeof fetch = fetch): Promise<Response> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetcher(url, { ...options, signal: AbortSignal.timeout(10_000) });
      if (response.ok) return response;
      if (response.status < 500 && ![408, 429].includes(response.status)) throw new ToolFailure(true, response.status);
    } catch (error) {
      if (error instanceof ToolFailure) throw error;
    }
  }
  throw new ToolFailure(false);
}

export async function startWorkflowJobs(boss: PgBoss, apiOrigin: string, authorization: string, concurrency: number, active: Set<string>, started: (jobId: string) => Promise<void>) {
  await boss.work(WORKFLOW_QUEUE, { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1, perJobResults: true }, async ([job]) => {
    if (job === undefined) return [];
    const payload = WorkflowJobPayload.safeParse(job.data);
    if (!payload.success || payload.data.requestId !== job.id) return [{ id: job.id, status: 'deadletter' as const, output: { error: 'malformed_payload' } }];
    active.add(job.id);
    try {
      await started(job.id);
      await toolFetch(new URL(`${WORKFLOW_WORKER_PATH}/${job.id}/deliver`, apiOrigin), { method: 'POST', headers: { authorization } });
      return [{ id: job.id, status: 'completed' as const }];
    } catch (error) {
      // A stale/cancelled approval requires an operator to redraft, never a new delivery.
      if (!(error instanceof ToolFailure && error.status === 409)) {
        // The scope is read from the persisted request by the protected API.
        await toolFetch(new URL(`${WORKFLOW_WORKER_PATH}/${job.id}/failure`, apiOrigin), {
          method: 'POST', headers: { authorization, 'content-type': 'application/json' },
          body: JSON.stringify({ revision: payload.data.revision, code: error instanceof ToolFailure && error.permanent ? 'permanent_tool_failure' : 'tool_retries_exhausted' }),
        });
      }
      return [{ id: job.id, status: 'deadletter' as const, output: { error: 'operator_action_required' } }];
    } finally { active.delete(job.id); }
  });
}
