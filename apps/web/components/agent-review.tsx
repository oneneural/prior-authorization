'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { postCase, refusal } from './command';
import { PRIMARY } from './command-button';

/** The reviewer's accept/reject choices for one run's valid proposals, sent together. */
export function AgentReview({ caseId, runId, proposalIds }: { caseId: string; runId: string; proposalIds: string[] }) {
  const router = useRouter();
  const intent = useRef<string | null>(null);
  const [choices, setChoices] = useState<Record<string, 'accept' | 'reject'>>({});
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startRefresh] = useTransition();

  async function submit() {
    setBusy(true);
    intent.current ??= crypto.randomUUID();
    const decisions = Object.entries(choices).map(([proposalId, decision]) => ({ proposalId, decision }));
    const result = await postCase(`${encodeURIComponent(caseId)}/agent-runs/${runId}/review`, { eventId: intent.current, decisions });
    setBusy(false);
    if (result.ok) {
      intent.current = null;
      setMessage({ tone: 'info', text: 'Review recorded. Accepted proposals are applied only if the case inputs are still current.' });
      startRefresh(() => router.refresh());
    } else {
      setMessage({ tone: 'error', text: refusal(result) });
    }
  }

  return (
    <fieldset className="flex flex-col gap-2 rounded-lg border border-line p-3">
      <legend className="px-1 text-sm font-medium">Reviewer decisions on valid proposals</legend>
      {proposalIds.map((id, index) => (
        <div key={id} role="radiogroup" aria-label={`Proposal ${index + 1}`} className="flex flex-wrap items-center gap-3 text-sm">
          <span className="font-mono text-xs">Proposal {index + 1} ({id.slice(0, 8)})</span>
          {(['accept', 'reject'] as const).map((decision) => (
            <label key={decision} className="flex items-center gap-1">
              <input type="radio" name={`proposal-${id}`} checked={choices[id] === decision} onChange={() => setChoices((current) => ({ ...current, [id]: decision }))} />
              {decision === 'accept' ? 'Accept as reviewed candidate' : 'Reject'}
            </label>
          ))}
        </div>
      ))}
      <button type="button" className={`${PRIMARY} w-fit`} disabled={busy} onClick={() => void submit()}>Record proposal review</button>
      <p role="status" aria-live="polite" className={message?.tone === 'error' ? 'text-sm text-warning' : 'text-sm text-muted'}>{message?.text ?? ''}</p>
    </fieldset>
  );
}
