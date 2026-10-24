import { PILOT_NOTICE } from '@pa/contracts';

/** Permanent PA-A11 label, shared by the root layout and the global error page. */
export function PilotNotice() {
  return (
    <div className="mx-auto max-w-5xl px-4 pt-8">
      <p role="note" className="rounded-lg border border-accent bg-accent-soft px-4 py-3 text-sm font-semibold">
        {PILOT_NOTICE}
      </p>
    </div>
  );
}
