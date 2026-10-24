import { CaseNav } from '../../../../components/case-nav';
import { CommandButton } from '../../../../components/command-button';
import { WorkbenchHeader } from '../../../../components/workbench-header';
import { caseDetail, caseWorkflow, requireSession } from '../../../../lib/cases';
import { FINDING_STATUS_LABELS, RECIPIENT_LABELS, REQUEST_STATE_LABELS, REQUEST_TEMPLATES, caseStateLabel, shortHash } from '../../../../lib/labels';

/**
 * Neutral missing-document requests. The API writes the request text from a
 * fixed template; approval is local and delivery is a simulated local receipt.
 * Nothing is transmitted and no order, note or signature is drafted.
 */
export default async function RequestReview({ params }: PageProps<'/cases/[caseId]/request'>) {
  const { caseId } = await params;
  const session = await requireSession();
  const [detail, workflow] = await Promise.all([caseDetail(caseId), caseWorkflow(caseId)]);
  const result = detail.assessment?.outcome === 'assessed' ? detail.assessment.result : null;
  const operator = session.actor.role === 'fixture_operator';
  const open = new Set(workflow.requests.filter((item) => !['closed', 'cancelled'].includes(item.state)).map((item) => item.ruleId));
  const requestable = (finding: { ruleId: string; status: string; conditions: { conditionKey: string }[] }) => {
    const template = REQUEST_TEMPLATES[finding.ruleId];
    return finding.status === 'missing' && template !== undefined && finding.conditions.every((condition) => template.conditionKeys.includes(condition.conditionKey));
  };
  const missing = (result?.findings ?? []).filter((finding) => finding.status === 'missing' && !open.has(finding.ruleId));
  const candidates = missing.filter(requestable);
  const operatorReview = missing.filter((finding) => !requestable(finding));
  const path = encodeURIComponent(caseId);

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
      <WorkbenchHeader session={session} />
      <CaseNav caseId={caseId} current="request" />
      <section aria-labelledby="request-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
        <h1 id="request-heading" className="text-2xl font-semibold">Request review: <span className="font-mono">{caseId}</span></h1>
        <p className="text-sm">State: {caseStateLabel(detail.state)}. Revision {detail.revision}.</p>
        <p className="rounded-md bg-warning-soft px-3 py-2 text-sm text-warning">
          Local simulation only: approval records a local receipt and nothing is sent. Requests ask for existing finalized records and never suggest what a clinician should write.
        </p>
        {workflow.binding === null && <p className="text-sm text-muted">No current packet: wait for the assessment to finish before drafting a request.</p>}
        {workflow.binding !== null && candidates.length === 0 && workflow.requests.length === 0 && <p className="text-sm text-muted">No missing administrative document can be requested with a neutral template on this revision.</p>}
        {workflow.binding !== null && candidates.map((finding) => {
          const template = REQUEST_TEMPLATES[finding.ruleId]!;
          return (
            <article key={finding.findingId} className="flex flex-col gap-2 rounded-lg border border-line p-3">
              <h2 className="font-medium">{finding.ruleId}: {FINDING_STATUS_LABELS[finding.status]}: {template.label}</h2>
              <p className="text-sm">{finding.explanation}</p>
              <p className="text-sm">Recipient: {RECIPIENT_LABELS[template.recipientRole]}.</p>
              {operator ? (
                <CommandButton path={`${path}/requests`} idempotent label={`Prepare neutral draft request for ${finding.ruleId}`} body={{ ...workflow.binding, findingId: finding.findingId, templateId: template.templateId, recipientRole: template.recipientRole }} />
              ) : <p className="text-sm text-muted">Only the fixture operator prepares requests.</p>}
            </article>
          );
        })}
        {operatorReview.length > 0 && (
          <p className="text-sm text-muted">
            No neutral template fits {operatorReview.map((finding) => finding.ruleId).join(', ')} on this revision; those findings need operator review or may resolve once a requested document arrives.
          </p>
        )}
      </section>

      <section aria-labelledby="requests-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
        <h2 id="requests-heading" className="text-lg font-semibold">Requests on this case</h2>
        {workflow.requests.length === 0 ? <p className="text-sm text-muted">No requests yet.</p> : workflow.requests.map((request) => {
          const receipt = workflow.receipts.find((item) => item.requestId === request.requestId);
          const stale = workflow.binding === null || request.payload.packetHash !== workflow.binding.packetHash || request.caseRevision !== detail.revision;
          return (
            <article key={request.requestId} className="flex flex-col gap-2 rounded-lg border border-line p-3" data-testid="request-preview">
              <p className="text-sm font-medium">{request.ruleId}: {REQUEST_STATE_LABELS[request.state] ?? request.state}</p>
              <blockquote className="border-l-4 border-accent pl-3 text-sm">{request.payload.body}</blockquote>
              <p className="text-xs text-muted">Recipient: {RECIPIENT_LABELS[request.payload.recipientRole] ?? request.payload.recipientRole}. Revision {request.caseRevision}. Content hash <span className="font-mono">{shortHash(request.contentHash)}</span>.</p>
              {receipt !== undefined && <p className="text-sm">Local receipt {receipt.receiptId.slice(0, 8)} ({receipt.mode.replaceAll('_', ' ')}): simulated, nothing transmitted.</p>}
              {request.state === 'draft' && stale && <p role="alert" className="text-sm text-warning">This draft is bound to an earlier packet or revision and can no longer be approved.</p>}
              {operator && request.state === 'draft' && (
                <CommandButton path={`${path}/requests/${request.requestId}/approve`} label="Approve local simulated request" body={{ expectedRevision: request.payload.expectedRevision, sourceRevisionHash: request.payload.sourceRevisionHash, policyPackSha256: request.payload.policyPackSha256, packetHash: request.payload.packetHash, contentHash: request.contentHash }} />
              )}
              {operator && request.state === 'simulated_delivered' && (
                <CommandButton path={`${path}/fixture-events`} label="Record fixture response (archived finalized order)" tone="secondary" body={{ expectedRevision: detail.revision, requestId: request.requestId, fixtureEvent: 'archive_f01' }} />
              )}
              {operator && ['simulated_delivered', 'response_received'].includes(request.state) && (
                <CommandButton path={`${path}/requests/${request.requestId}/close`} label="Close unresolved request" tone="secondary" confirm="Close this request? A follow-up request can then be drafted. Nothing is sent." body={{}} />
              )}
            </article>
          );
        })}
      </section>
    </main>
  );
}
