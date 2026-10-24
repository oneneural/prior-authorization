import { CaseNav } from '../../../../../../components/case-nav';
import { WorkbenchHeader } from '../../../../../../components/workbench-header';
import { loadOptional, requireSession } from '../../../../../../lib/cases';
import { shortHash } from '../../../../../../lib/labels';

interface Located { documentId: string; version: number; contentHash: string; locator: string; originalText: string }
interface WholeSource { metadata: { documentId: string; version: number; kind: string; contentHash: string }; payload: string }

/** The original source version, read through the scoped API; a locator shows the exact cited value. */
export default async function SourcePage({ params, searchParams }: PageProps<'/cases/[caseId]/sources/[documentId]/[version]'>) {
  const { caseId, documentId, version } = await params;
  const locator = (await searchParams).locator;
  const session = await requireSession();
  const base = `/api/cases/${encodeURIComponent(caseId)}/documents/${encodeURIComponent(documentId)}/versions/${encodeURIComponent(version)}`;
  const whole = await loadOptional<WholeSource>(base);
  const located = typeof locator === 'string' ? await loadOptional<Located>(`${base}?locator=${encodeURIComponent(locator)}`) : null;

  return (
    <main className="mx-auto flex max-w-6xl flex-col gap-6 px-4 pt-6 pb-8">
      <WorkbenchHeader session={session} />
      <CaseNav caseId={caseId} current="source" />
      <section aria-labelledby="source-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
        <h1 id="source-heading" className="text-2xl font-semibold">Source <span className="font-mono">{documentId}</span> version {version}</h1>
        {located !== null && (located.ok ? (
          <div className="rounded-lg border-2 border-accent p-3" data-testid="citation">
            <p className="text-sm text-muted">Cited value at <span className="font-mono">{located.body.locator}</span></p>
            <p className="text-lg">&ldquo;{located.body.originalText}&rdquo;</p>
            <p className="font-mono text-xs text-muted">Source hash {shortHash(located.body.contentHash)}</p>
          </div>
        ) : <p role="alert" className="text-sm text-warning">The cited location could not be read: {located.message}.</p>)}
        {whole.ok ? (
          <>
            <p className="text-sm">Kind {whole.body.metadata.kind.replaceAll('_', ' ')}; content hash <span className="font-mono">{shortHash(whole.body.metadata.contentHash)}</span>. Original synthetic source, unedited; shown formatted for reading.</p>
            <pre className="max-h-[32rem] overflow-auto rounded-lg border border-line bg-canvas p-3 text-xs" tabIndex={0} aria-label="Original source JSON">{JSON.stringify(JSON.parse(whole.body.payload), null, 2)}</pre>
          </>
        ) : <p role="alert" className="text-sm text-warning">This source is not available to read: {whole.message}.</p>}
      </section>
    </main>
  );
}
