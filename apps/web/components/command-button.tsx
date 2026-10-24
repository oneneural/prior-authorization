'use client';

import { useRouter } from 'next/navigation';
import { useId, useRef, useState, useTransition } from 'react';

import { postCase, refusal } from './command';

interface Props {
  /** Path under /api/cases/, for example `case-f02/assess`. */
  path: string;
  body: Record<string, unknown>;
  label: string;
  /** Adds a per-intent idempotency key as well as the event ID. */
  idempotent?: boolean;
  /** When set, a labelled confirmation dialog must be accepted first. */
  confirm?: string;
  tone?: 'primary' | 'secondary';
}

const BUTTON = 'h-10 rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:opacity-60';
export const PRIMARY = `${BUTTON} bg-accent text-panel`;
export const SECONDARY = `${BUTTON} border border-line bg-panel`;

/**
 * One command with a stable event ID per intent: a retry after any failure
 * reuses it, and only a confirmed success retires it. A refused command keeps
 * the current view in place and says why in text.
 */
export function CommandButton({ path, body, label, idempotent = false, confirm, tone = 'primary' }: Props) {
  const router = useRouter();
  const intent = useRef<{ eventId: string; idempotencyKey: string } | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [busy, setBusy] = useState(false);
  const [, startRefresh] = useTransition();
  const [message, setMessage] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  async function run() {
    setBusy(true);
    setMessage(null);
    intent.current ??= { eventId: crypto.randomUUID(), idempotencyKey: `web-${crypto.randomUUID()}` };
    const result = await postCase(path, { ...body, eventId: intent.current.eventId, ...(idempotent ? { idempotencyKey: intent.current.idempotencyKey } : {}) });
    setBusy(false);
    if (result.ok) {
      intent.current = null;
      setMessage({ tone: 'info', text: `${label}: recorded.` });
      startRefresh(() => router.refresh());
    } else {
      setMessage({ tone: 'error', text: refusal(result) });
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <button type="button" className={tone === 'primary' ? PRIMARY : SECONDARY} disabled={busy} onClick={() => (confirm === undefined ? void run() : dialog.current?.showModal())}>
        {busy ? `${label}…` : label}
      </button>
      {confirm !== undefined && (
        <dialog ref={dialog} aria-labelledby={titleId} className="m-auto max-w-md rounded-xl border border-line bg-panel p-4 text-ink backdrop:bg-black/40">
          <h2 id={titleId} className="text-lg font-semibold">{label}</h2>
          <p className="mt-2 text-sm">{confirm}</p>
          <form method="dialog" className="mt-4 flex gap-3">
            <button type="submit" className={PRIMARY} onClick={() => void run()}>Confirm</button>
            <button type="submit" className={SECONDARY} autoFocus>Keep the case unchanged</button>
          </form>
        </dialog>
      )}
      <p role="status" aria-live="polite" className={message?.tone === 'error' ? 'text-sm text-warning' : 'text-sm text-muted'}>{message?.text ?? ''}</p>
    </div>
  );
}
