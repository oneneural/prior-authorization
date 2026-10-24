'use client';

import { useRouter } from 'next/navigation';
import { useRef, useState, useTransition } from 'react';

import { CreateProbeResponse, ErrorResponse } from '@pa/contracts';

type Message = { tone: 'info' | 'error'; text: string };

/** Submits one synthetic probe through the same-origin proxy, then refreshes server state. */
export function CreateProbe() {
  const router = useRouter();
  // One idempotency key per submission intent. A retry after any failure reuses it,
  // so a lost response cannot create a second probe; only a confirmed 2xx retires it.
  const intentKey = useRef<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [message, setMessage] = useState<Message | null>(null);

  async function submit() {
    setSubmitting(true);
    setMessage(null);
    intentKey.current ??= crypto.randomUUID();
    try {
      const response = await fetch('/api/pilot/probes', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'idempotency-key': intentKey.current },
        body: JSON.stringify({ label: 'Synthetic pilot probe' }),
      });
      const body: unknown = await response.json();
      if (response.ok) {
        const { probe, replayed } = CreateProbeResponse.parse(body);
        intentKey.current = null;
        const outcome = replayed ? 'was already recorded' : 'submitted';
        setMessage({ tone: 'info', text: `Probe ${probe.probeId} ${outcome}. Status: ${probe.status}.` });
      } else {
        const error = ErrorResponse.safeParse(body);
        const reason = error.success ? error.data.error.message : `HTTP ${response.status}`;
        setMessage({ tone: 'error', text: `Submission failed: ${reason}. Retrying reuses the same request key.` });
      }
    } catch {
      setMessage({ tone: 'error', text: 'Submission failed: the web server could not be reached. Retrying reuses the same request key.' });
    } finally {
      setSubmitting(false);
      startRefresh(() => router.refresh());
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={submitting}
          className="h-10 rounded-lg bg-accent px-4 text-sm font-medium text-panel focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {submitting ? 'Submitting probe…' : 'Submit synthetic probe'}
        </button>
        <button
          type="button"
          onClick={() => startRefresh(() => router.refresh())}
          disabled={refreshing}
          className="h-10 rounded-lg border border-line bg-panel px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60"
        >
          {refreshing ? 'Refreshing…' : 'Refresh status'}
        </button>
      </div>
      <p role="status" aria-live="polite" className={message?.tone === 'error' ? 'text-sm text-warning' : 'text-sm text-muted'}>
        {message?.text ?? ''}
      </p>
    </div>
  );
}
