'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import type { RevisionBinding } from '@pa/contracts';

import { postCase, refusal } from './command';
import { PRIMARY, SECONDARY } from './command-button';

/**
 * Accept or return the exact packet revision shown. The binding is the one the
 * page rendered; if the case moved on, the API refuses it as stale and the
 * preview stays on screen.
 */
export function ReviewForm({ caseId, binding, canAccept }: { caseId: string; binding: RevisionBinding; canAccept: boolean }) {
  const router = useRouter();
  const intent = useRef<string | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [, startRefresh] = useTransition();

  async function decide(decision: 'accept_for_review' | 'return') {
    if (reason.trim() === '') {
      setMessage({ tone: 'error', text: 'A reason is required for either decision.' });
      return;
    }
    setBusy(true);
    intent.current ??= crypto.randomUUID();
    const result = await postCase(`${encodeURIComponent(caseId)}/reviews`, { ...binding, eventId: intent.current, decision, reason });
    setBusy(false);
    if (result.ok) {
      intent.current = null;
      setMessage({ tone: 'info', text: decision === 'accept_for_review' ? 'Accepted for further review. This is administrative only: qualified clinical review, payer authorization and payment remain separate and undecided.' : 'Returned for administrative follow-up.' });
      startRefresh(() => router.refresh());
    } else {
      setMessage({ tone: 'error', text: refusal(result) });
    }
  }

  return (
    <form className="flex flex-col gap-3" onSubmit={(event) => event.preventDefault()}>
      <label htmlFor="review-reason" className="text-sm font-medium">Reason (recorded with this packet revision)</label>
      <textarea id="review-reason" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={2000} rows={3} className="rounded-lg border border-line bg-panel p-2 text-sm" />
      <div className="flex flex-wrap gap-3">
        <button type="button" className={PRIMARY} disabled={busy || !canAccept} onClick={() => void decide('accept_for_review')}>Accept for further review (administrative only)</button>
        <button type="button" className={SECONDARY} disabled={busy} onClick={() => void decide('return')}>Return packet</button>
      </div>
      {!canAccept && <p className="text-sm text-muted">Acceptance is available only when the case is ready for administrative review.</p>}
      <p role="status" aria-live="polite" className={message?.tone === 'error' ? 'text-sm text-warning' : 'text-sm text-muted'}>{message?.text ?? ''}</p>
    </form>
  );
}
