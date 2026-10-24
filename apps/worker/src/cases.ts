import { CASE_QUEUE, CASE_WORKER_PATH, CaseJobPayload, CaseJobScope, CaseResultReport } from '@pa/contracts';
import type { PgBoss } from '@pa/db';
import { assessV2, type AssessmentInputV2 } from '@pa/domain';

import { toolFetch, ToolFailure } from './workflow.js';

const bytes = (text: string) => new TextEncoder().encode(text);

/** The only scope source is the API's persisted active job, not the queue payload. */
export async function processCaseJob(jobId: string, apiOrigin: string, authorization: string) {
  const response = await toolFetch(new URL(`${CASE_WORKER_PATH}/${jobId}`, apiOrigin), { headers: { authorization }, signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`case scope read failed: ${response.status}`);
  const scope = CaseJobScope.parse(await response.json());
  if (scope.jobId !== jobId) throw new Error('case job scope mismatch');
  const input: AssessmentInputV2 = {
    caseBytes: bytes(scope.snapshot.caseText), policyPackBytes: bytes(scope.snapshot.policyText),
    assessmentDate: (JSON.parse(scope.snapshot.caseText) as { assessmentDate: string }).assessmentDate,
    documents: scope.snapshot.documents.map((doc) => ({ slot: doc.slot, metadata: bytes(doc.metadataText), payload: doc.payload === null ? null : bytes(doc.payload) })),
  };
  const report = CaseResultReport.parse({ caseId: scope.caseId, revision: scope.revision, outcome: await assessV2(input) });
  const saved = await toolFetch(new URL(`${CASE_WORKER_PATH}/${jobId}/result`, apiOrigin), {
    method: 'POST', headers: { authorization, 'content-type': 'application/json' }, body: JSON.stringify(report), signal: AbortSignal.timeout(10_000),
  });
  if (!saved.ok) throw new Error(`case result rejected: ${saved.status}`);
}

export async function startCaseJobs(boss: PgBoss, apiOrigin: string, authorization: string, concurrency: number, active: Set<string>, started: (jobId: string) => Promise<void>) {
  await boss.work(CASE_QUEUE, { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1, perJobResults: true }, async ([job]) => {
    if (job === undefined) return [];
    if (!CaseJobPayload.safeParse(job.data).success) return [{ id: job.id, status: 'deadletter' as const, output: { error: 'malformed_payload' } }];
    active.add(job.id);
    try {
      await started(job.id);
      try {
        await processCaseJob(job.id, apiOrigin, authorization);
        return [{ id: job.id, status: 'completed' as const }];
      } catch (error) {
        if (!(error instanceof ToolFailure && [404, 409].includes(error.status ?? 0))) {
          await toolFetch(new URL(`${CASE_WORKER_PATH}/${job.id}/failure`, apiOrigin), {
            method: 'POST', headers: { authorization, 'content-type': 'application/json' },
            body: JSON.stringify({ revision: CaseJobPayload.parse(job.data).revision, code: error instanceof ToolFailure && !error.permanent ? 'tool_retries_exhausted' : 'permanent_tool_failure' }),
          });
        }
        return [{ id: job.id, status: 'deadletter' as const, output: { error: 'operator_action_required' } }];
      }
    } finally { active.delete(job.id); }
  });
}
