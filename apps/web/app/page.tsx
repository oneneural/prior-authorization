import Link from 'next/link';

import { CASE_NOTICE } from '@pa/contracts';

import { WorkbenchHeader } from '../components/workbench-header';
import { load, requireSession, type CaseRow } from '../lib/cases';
import { caseStateLabel } from '../lib/labels';

export default async function QueuePage() {
  const session = await requireSession();
  const { cases } = await load<{ cases: CaseRow[] }>('/api/cases');

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
      <WorkbenchHeader session={session} />
      <section aria-labelledby="queue-heading" className="flex flex-col gap-3">
        <h1 id="queue-heading" className="text-2xl font-semibold">Case queue</h1>
        <p className="text-sm text-muted">
          Administrative states only. No approval likelihood is shown or estimated. {CASE_NOTICE}
        </p>
        {cases.length === 0 ? (
          <p className="rounded-lg border border-line bg-panel px-3 py-2 text-sm" data-testid="empty-queue">No cases are in your team&apos;s scope.</p>
        ) : (
          <div className="overflow-x-auto rounded-xl border border-line bg-panel">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Synthetic cases in your scope</caption>
              <thead className="border-b border-line text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Case</th>
                  <th scope="col" className="px-3 py-2 font-medium">Scoped item</th>
                  <th scope="col" className="px-3 py-2 font-medium">Administrative state</th>
                  <th scope="col" className="px-3 py-2 font-medium">Outstanding issues</th>
                  <th scope="col" className="px-3 py-2 font-medium">Clinical questions</th>
                  <th scope="col" className="px-3 py-2 font-medium">Owner</th>
                  <th scope="col" className="px-3 py-2 font-medium">Last evidence update</th>
                </tr>
              </thead>
              <tbody>
                {cases.map((row) => (
                  <tr key={row.caseId} className="border-b border-line last:border-0">
                    <td className="px-3 py-2">
                      <span className="mr-2 rounded bg-accent-soft px-1.5 py-0.5 text-xs">Synthetic</span>
                      <Link className="font-mono text-accent underline" href={`/cases/${encodeURIComponent(row.caseId)}`}>{row.caseId}</Link>
                      <span className="block text-xs text-muted">revision {row.revision}</span>
                    </td>
                    <td className="px-3 py-2">{row.itemCode ?? 'Not supplied'}{row.requestKind === null ? '' : `, ${row.requestKind.replaceAll('_', ' ')}`}</td>
                    <td className="px-3 py-2">{caseStateLabel(row.state)}</td>
                    <td className="px-3 py-2 tabular-nums">{row.outstandingIssues ?? 'Pending assessment'}</td>
                    <td className="px-3 py-2 tabular-nums">{row.clinicalQuestions === null ? 'Pending assessment' : `${row.clinicalQuestions} for qualified review`}</td>
                    <td className="px-3 py-2">{row.ownerId} team</td>
                    <td className="px-3 py-2 tabular-nums">{row.lastEvidenceUpdate === null ? 'None' : `${row.lastEvidenceUpdate.replace('T', ' ').slice(0, 19)} UTC`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
