import { CASE_NOTICE } from '@pa/contracts';

import { CaseNav } from '../../../../components/case-nav';
import { ReviewForm } from '../../../../components/review-form';
import { WorkbenchHeader } from '../../../../components/workbench-header';
import { caseDetail, caseDocuments, caseWorkflow, requireSession } from '../../../../lib/cases';
import { FINDING_STATUS_LABELS, caseStateLabel, shortHash, sourceHref } from '../../../../lib/labels';

export default async function PacketReview({ params }: PageProps<'/cases/[caseId]/packet'>) {
  const { caseId } = await params;
  const session = await requireSession();
  const [detail, { documents }, workflow] = await Promise.all([caseDetail(caseId), caseDocuments(caseId), caseWorkflow(caseId)]);
  const current = workflow.packets.find((item) => !item.superseded)?.packet ?? null;
  const included = new Set(current?.includedDocumentRefs.map((ref) => `${ref.documentId}@${ref.version}`) ?? []);
  const omitted = documents.filter((doc) => !included.has(`${doc.documentId}@${doc.version}`));

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
      <WorkbenchHeader session={session} />
      <CaseNav caseId={caseId} current="packet" />
      <p role="note" className="rounded-xl border-2 border-warning bg-warning-soft px-4 py-3 text-lg font-semibold text-warning" data-testid="packet-notice">
        Administrative review only. No payer submission.
      </p>
      <section aria-labelledby="packet-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
        <h1 id="packet-heading" className="text-2xl font-semibold">Packet review: <span className="font-mono">{caseId}</span></h1>
        <p className="text-sm">State: {caseStateLabel(detail.state)}. Clinical review status: requires qualified review (not provided by this lab).</p>
        {current === null || workflow.binding === null ? (
          <p className="text-sm text-muted">No current packet: the case is being assessed, needs recovery or is cancelled.</p>
        ) : (
          <>
            <p className="font-mono text-xs" data-testid="packet-binding">
              Packet {current.packetId}, hash {shortHash(current.packetHash)}; revision {current.caseRevision}; policy {current.policyPackId} {shortHash(current.policyPackSha256)}.
            </p>
            <h2 className="text-lg font-semibold">Included documents</h2>
            <ul className="list-disc pl-5 text-sm">
              {current.documents.map(({ metadata }) => (
                <li key={`${metadata.documentId}@${metadata.version}`}>
                  <a className="text-accent underline" href={sourceHref(caseId, metadata.documentId, metadata.version)}>{metadata.documentId} v{metadata.version}</a> ({metadata.kind.replaceAll('_', ' ')})
                </li>
              ))}
            </ul>
            <h2 className="text-lg font-semibold">Omitted from the packet</h2>
            {omitted.length === 0 ? <p className="text-sm text-muted">Nothing omitted.</p> : (
              <ul className="list-disc pl-5 text-sm">
                {omitted.map((doc) => <li key={`${doc.documentId}@${doc.version}`}>{doc.documentId} v{doc.version} ({doc.kind.replaceAll('_', ' ')}): {doc.kind === 'supporting_note' ? 'irrelevant to the administrative rules' : doc.accessStatus !== 'available' ? 'not readable' : 'withheld or superseded'}</li>)}
              </ul>
            )}
            <h2 className="text-lg font-semibold">Rule findings</h2>
            <ul className="text-sm">
              {current.findings.map((finding) => <li key={finding.findingId}><span className="font-mono">{finding.ruleId}</span>: {FINDING_STATUS_LABELS[finding.status] ?? finding.status}</li>)}
            </ul>
            <h2 className="text-lg font-semibold">Unresolved clinical questions</h2>
            <ul className="list-disc pl-5 text-sm">
              {current.findings.filter((finding) => finding.status === 'manual_review').map((finding) => <li key={finding.findingId}>{finding.ruleId}: {finding.explanation}</li>)}
              <li>Every clinical question requires qualified review outside this lab.</li>
            </ul>
            <h2 className="text-lg font-semibold">Limitations</h2>
            <ul className="list-disc pl-5 text-sm">{current.limitations.map((item) => <li key={item}>{item}</li>)}</ul>
            {session.actor.role === 'fixture_administrative_reviewer'
              ? <ReviewForm caseId={caseId} binding={workflow.binding} canAccept={detail.state === 'ready_for_review'} />
              : <p className="text-sm text-muted">Only the fixture administrative reviewer records packet decisions.</p>}
          </>
        )}
      </section>
      <section aria-labelledby="decisions-heading" className="flex flex-col gap-2 rounded-xl border border-line bg-panel p-4">
        <h2 id="decisions-heading" className="text-lg font-semibold">Recorded decisions</h2>
        {workflow.decisions.length === 0 ? <p className="text-sm text-muted">None.</p> : (
          <ul className="text-sm">
            {workflow.decisions.map((decision) => (
              <li key={decision.decisionId}>
                {decision.decision === 'accept_for_review' ? 'Accepted for further review (administrative only)' : 'Returned'} by a {decision.role.replaceAll('_', ' ')} on revision {decision.binding.expectedRevision}, packet {shortHash(decision.binding.packetHash)}: {decision.reason}
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted">{CASE_NOTICE}</p>
      </section>
    </main>
  );
}
