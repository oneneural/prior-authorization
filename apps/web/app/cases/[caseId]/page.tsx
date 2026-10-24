import { AgentPanel } from '../../../components/agent-panel';
import { CaseNav } from '../../../components/case-nav';
import { CommandButton } from '../../../components/command-button';
import { Timeline } from '../../../components/timeline';
import { WorkbenchHeader } from '../../../components/workbench-header';
import { caseDetail, caseDocuments, caseWorkflow, requireSession } from '../../../lib/cases';
import { ACCESS_STATUS_LABELS, FINDING_STATUS_LABELS, RESPONSIBLE_ROLE_LABELS, caseStateLabel, shortHash, sourceHref } from '../../../lib/labels';

export default async function CaseWorkspace({ params }: PageProps<'/cases/[caseId]'>) {
  const { caseId } = await params;
  const session = await requireSession();
  const [detail, { documents }, workflow] = await Promise.all([caseDetail(caseId), caseDocuments(caseId), caseWorkflow(caseId)]);
  const result = detail.assessment?.outcome === 'assessed' ? detail.assessment.result : null;
  const facts = new Map((result?.evidenceFacts ?? []).map((fact) => [fact.factId, fact]));
  const withheld = new Set((result?.quarantinedDocuments ?? []).map((ref) => `${ref.documentId}@${ref.version}`));
  const current = workflow.packets.find((item) => !item.superseded)?.packet ?? null;
  const operator = session.actor.role === 'fixture_operator';
  const record = detail.record;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
      <WorkbenchHeader session={session} />
      <CaseNav caseId={caseId} current="workspace" />
      <section aria-labelledby="scope-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h1 id="scope-heading" className="text-2xl font-semibold">Case <span className="font-mono">{caseId}</span></h1>
        <p className="text-sm"><span className="rounded bg-accent-soft px-1.5 py-0.5 text-xs">Synthetic</span> Item {record.itemCode ?? 'not supplied'}, {record.requestKind.replaceAll('_', ' ')}, payer type {record.payerType.replaceAll('_', ' ')}, jurisdiction {record.jurisdiction}, urgency {record.urgency}.</p>
        <p className="text-sm font-medium" data-testid="case-state">Administrative state: {caseStateLabel(detail.state)}</p>
        <p className="text-sm text-muted">Clinical questions: requires qualified review outside this lab. Payer authorization and payment: not decided here.</p>
        <dl className="grid grid-cols-1 gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
          <div><dt className="inline text-muted">Owner: </dt><dd className="inline">{detail.ownerId} team</dd></div>
          <div><dt className="inline text-muted">Case revision: </dt><dd className="inline">{detail.revision}</dd></div>
          <div><dt className="inline text-muted">Policy snapshot: </dt><dd className="inline font-mono text-xs">{result === null ? 'pending assessment' : `${result.policyPackId} ${shortHash(result.policyPackSha256)}`}</dd></div>
          <div><dt className="inline text-muted">Evidence freshness: </dt><dd className="inline">{workflow.binding === null ? 'No current packet: assessment pending, failed or cancelled' : `Current packet ${shortHash(workflow.binding.packetHash)} on sources ${shortHash(workflow.binding.sourceRevisionHash)}`}</dd></div>
        </dl>
        {operator && detail.state !== 'cancelled' && (
          <div className="mt-2 flex flex-wrap gap-4">
            {detail.state === 'recoverable_error'
              ? <CommandButton path={`${encodeURIComponent(caseId)}/recover`} body={{ expectedRevision: detail.revision }} label="Recover and reassess" />
              : <CommandButton path={`${encodeURIComponent(caseId)}/assess`} body={{ expectedRevision: detail.revision }} label="Reassess current revision" tone="secondary" />}
            <CommandButton path={`${encodeURIComponent(caseId)}/cancel`} body={{ expectedRevision: detail.revision }} label="Cancel case" tone="secondary" confirm="Cancellation is terminal: open drafts are cancelled and later fixture responses are kept for audit only." />
          </div>
        )}
      </section>

      <section aria-labelledby="documents-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 id="documents-heading" className="text-lg font-semibold">Source documents</h2>
        <ul className="flex flex-col gap-1 text-sm">
          {documents.map((doc) => {
            const key = `${doc.documentId}@${doc.version}`;
            const status = withheld.has(key) ? 'Withheld: identity or binding check failed' : (ACCESS_STATUS_LABELS[doc.accessStatus] ?? doc.accessStatus);
            return (
              <li key={key} className="flex flex-wrap gap-x-3 border-b border-line py-1 last:border-0">
                <span className="font-mono">{doc.documentId} v{doc.version}</span>
                <span>{doc.kind.replaceAll('_', ' ')}</span>
                <span className="font-medium">{status}</span>
                {doc.supersedes !== null && <span className="text-muted">supersedes {doc.supersedes.documentId} v{doc.supersedes.version}</span>}
                {doc.accessStatus === 'available' && !withheld.has(key) && <a className="text-accent underline" href={sourceHref(caseId, doc.documentId, doc.version)}>Open source</a>}
              </li>
            );
          })}
        </ul>
        <p className="text-xs text-muted">Missing documents are reported by the requirement findings below as &ldquo;Not supplied&rdquo;.</p>
      </section>

      <section aria-labelledby="matrix-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 id="matrix-heading" className="text-lg font-semibold">Requirement matrix</h2>
        {result === null ? <p className="text-sm text-muted">Assessment pending: no requirement findings yet.</p> : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Administrative requirement findings with cited evidence</caption>
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="py-2 pr-3 font-medium">Rule</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Status</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Explanation</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Cited evidence</th>
                  <th scope="col" className="py-2 pr-3 font-medium">Responsible role</th>
                </tr>
              </thead>
              <tbody>
                {result.findings.map((finding) => (
                  <tr key={finding.findingId} className="border-b border-line align-top last:border-0">
                    <td className="py-2 pr-3 font-mono">{finding.ruleId}</td>
                    <td className="py-2 pr-3">
                      <span className="font-medium">{FINDING_STATUS_LABELS[finding.status] ?? finding.status}</span>
                      <span className="block text-xs text-muted">{finding.severity.replaceAll('_', ' ')}</span>
                      {finding.conditions.map((condition) => <span key={`${condition.conditionKey}-${condition.field ?? ''}`} className="block font-mono text-xs text-muted">{condition.conditionKey}</span>)}
                    </td>
                    <td className="py-2 pr-3">{finding.explanation}</td>
                    <td className="py-2 pr-3">
                      {finding.evidenceFactIds.length === 0 ? <span className="text-muted">None cited</span> : (
                        <ul className="flex flex-col gap-1">
                          {finding.evidenceFactIds.map((id) => {
                            const fact = facts.get(id);
                            if (fact === undefined) return null;
                            return (
                              <li key={id}>
                                {fact.field}: &ldquo;{fact.originalText}&rdquo;{' '}
                                {withheld.has(`${fact.documentId}@${fact.documentVersion}`) ? <span className="text-muted">(source withheld)</span> : (
                                  <a className="text-accent underline" href={sourceHref(caseId, fact.documentId, fact.documentVersion, fact.locator)}>
                                    {fact.documentId} v{fact.documentVersion} {fact.locator}
                                  </a>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}
                    </td>
                    <td className="py-2 pr-3">{RESPONSIBLE_ROLE_LABELS[finding.responsibleRole] ?? finding.responsibleRole}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="clinical-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 id="clinical-heading" className="text-lg font-semibold">Clinical questions and policy limitations</h2>
        <ul className="list-disc pl-5 text-sm">
          {(result?.findings ?? []).filter((finding) => finding.status === 'manual_review').map((finding) => (
            <li key={finding.findingId}>{finding.ruleId}: {finding.explanation} Requires qualified clinical review; this lab does not decide it.</li>
          ))}
          {(current?.limitations ?? ['Original synthetic inputs only.', 'Clinical questions require qualified review.']).map((item) => <li key={item}>{item}</li>)}
        </ul>
      </section>

      <section aria-labelledby="timeline-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 id="timeline-heading" className="text-lg font-semibold">Timeline</h2>
        <Timeline caseId={caseId} />
      </section>

      <AgentPanel caseId={caseId} revision={detail.revision} actor={session.actor} bound={workflow.binding !== null} />
    </main>
  );
}
