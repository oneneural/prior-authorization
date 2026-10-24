import Link from 'next/link';

const LINK = 'rounded-md px-2 py-1 text-accent underline focus-visible:outline-2 focus-visible:outline-accent';

/** Breadcrumb and the case's three views. */
export function CaseNav({ caseId, current }: { caseId: string; current: 'workspace' | 'request' | 'packet' | 'source' }) {
  const base = `/cases/${encodeURIComponent(caseId)}`;
  const views = [
    { key: 'workspace', href: base, label: 'Case workspace' },
    { key: 'request', href: `${base}/request`, label: 'Request review' },
    { key: 'packet', href: `${base}/packet`, label: 'Packet review' },
  ] as const;
  return (
    <nav aria-label="Case views" className="flex flex-wrap items-center gap-2 text-sm">
      <Link className={LINK} href="/">Case queue</Link>
      <span aria-hidden="true">/</span>
      {views.map((view) => (
        <Link key={view.key} href={view.href} className={LINK} aria-current={current === view.key ? 'page' : undefined}>{view.label}</Link>
      ))}
    </nav>
  );
}
