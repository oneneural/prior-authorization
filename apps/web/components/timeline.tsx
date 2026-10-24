'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';

import { CaseEventFrame } from '@pa/contracts';

const TYPE_LABELS: Record<string, string> = {
  case_revision_created: 'Case revision created from synthetic sources',
  assessment_queued: 'Administrative assessment queued',
  assessment_recorded: 'Administrative assessment recorded',
  request_drafted: 'Neutral request drafted',
  request_simulated_delivered: 'Simulated local delivery recorded (nothing transmitted)',
  fixture_response: 'Fixture response recorded',
  request_closed_after_reassessment: 'Request closed after reassessment',
  packet_reviewed: 'Administrative packet decision recorded',
  cancel: 'Case cancelled',
  recover: 'Recovery requested',
  agent_run_queued: 'Recorded investigation queued',
  agent_run_awaiting_review: 'Recorded investigation awaiting review',
  agent_run_completed: 'Recorded investigation completed',
};

function label(type: string) {
  const [base] = type.split(':');
  if (base === 'request_approved') return 'Request approved locally';
  if (base === 'agent_reviewed') return 'Recorded proposals reviewed';
  if (base === 'operator_action_required') return `Operator action required (${type.split(':')[1] ?? 'unknown'})`;
  if (base === 'agent_run_failed') return 'Recorded investigation failed';
  if (base === 'request_closed') return 'Request closed by the operator';
  if (base === 'agent_run_cancelled') return 'Recorded investigation cancelled by the operator';
  return TYPE_LABELS[type] ?? type;
}

/**
 * Durable case events over the scoped SSE route. EventSource reconnects with
 * Last-Event-ID, so missed events replay in order; a `revoked` event ends the
 * stream for good. New events refresh the server-rendered view.
 */
export function Timeline({ caseId }: { caseId: string }) {
  const router = useRouter();
  const [events, setEvents] = useState<CaseEventFrame[]>([]);
  const [status, setStatus] = useState('Connecting to the case event stream…');
  const lastRefresh = useRef(0);

  useEffect(() => {
    const source = new EventSource(`/api/cases/${encodeURIComponent(caseId)}/events`);
    source.onopen = () => setStatus('Live: durable case events, replayed in order after reconnects.');
    source.onerror = () => setStatus('Reconnecting: missed events will replay from the last one received.');
    source.addEventListener('case_event', (message) => {
      const frame = CaseEventFrame.safeParse(JSON.parse((message as MessageEvent<string>).data));
      if (!frame.success) return;
      setEvents((current) => (current.some((item) => item.sequence === frame.data.sequence) ? current : [...current, frame.data]));
      // Coalesce bursts of events into one server refresh.
      const now = Date.now();
      if (now - lastRefresh.current > 1_000) {
        lastRefresh.current = now;
        setTimeout(() => router.refresh(), 300);
      }
    });
    source.addEventListener('revoked', () => {
      source.close();
      setStatus('Stream closed: the session or case access ended. Sign in again to continue.');
    });
    return () => source.close();
  }, [caseId, router]);

  return (
    <div className="flex flex-col gap-2">
      <p role="status" aria-live="polite" className="text-sm text-muted">{status}</p>
      <ol className="flex flex-col gap-1 text-sm" data-testid="timeline">
        {events.map((item) => (
          <li key={item.sequence} className="flex flex-wrap gap-x-3 border-b border-line py-1 last:border-0">
            <span className="font-mono text-xs text-muted tabular-nums">#{item.sequence}</span>
            <span>{label(item.type)}</span>
            <span className="text-muted">revision {item.inputRevision}</span>
            <time className="text-muted tabular-nums" dateTime={item.occurredAt}>{item.occurredAt.replace('T', ' ').slice(0, 19)} UTC</time>
          </li>
        ))}
      </ol>
    </div>
  );
}
