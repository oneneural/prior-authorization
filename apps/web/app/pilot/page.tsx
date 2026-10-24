import { connection } from 'next/server';

import { API_ORIGIN } from '@pa/config/topology';
import { ErrorResponse, StatusResponse } from '@pa/contracts';

import { CreateProbe } from '../create-probe';

type LoadedStatus = { kind: 'ok'; status: StatusResponse } | { kind: 'database_unavailable' } | { kind: 'api_unavailable' };

async function loadStatus(): Promise<LoadedStatus> {
  try {
    const response = await fetch(new URL('/api/status', API_ORIGIN), { cache: 'no-store' });
    const body: unknown = await response.json();
    if (response.ok) {
      return { kind: 'ok', status: StatusResponse.parse(body) };
    }
    // The API answered but could not reach the database; nothing about probes is known.
    const error = ErrorResponse.safeParse(body);
    return error.success && error.data.error.code === 'database_unavailable' ? { kind: 'database_unavailable' } : { kind: 'api_unavailable' };
  } catch {
    return { kind: 'api_unavailable' };
  }
}

export default async function StatusPage() {
  await connection();
  const loaded = await loadStatus();
  const status = loaded.kind === 'ok' ? loaded.status : null;

  return (
    <main className="mx-auto flex max-w-5xl flex-col gap-6 px-4 pt-6 pb-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-2xl font-semibold">Prior authorization packaging pilot</h1>
        <p className="text-sm text-muted">
          Service boundary check for the web proxy, API, queue and worker. It shows synthetic pilot probes only, not cases or
          clinical evidence.
        </p>
        <p className="w-fit rounded-md border border-line bg-panel px-3 py-1 font-mono text-sm" data-testid="mode-label">
          {/* Modes come only from the API; this page never assumes them. */}
          {status === null
            ? `Mode unknown: data unknown, agent unknown, agent graph unknown, identity unknown (${loaded.kind === 'database_unavailable' ? 'database' : 'API'} unavailable)`
            : `Fixture mode: data ${status.modes.data}, agent ${status.modes.agent}, agent graph ${status.modes.agentGraph}, identity ${status.modes.auth}`}
        </p>
      </header>

      <section className="flex flex-col gap-4 rounded-xl border border-line bg-panel p-4" aria-labelledby="probes-heading">
        <h2 id="probes-heading" className="text-lg font-semibold">
          Pilot probes
        </h2>
        <CreateProbe />
        {loaded.kind === 'api_unavailable' ? (
          <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            API unavailable: probe status could not be read. Nothing was submitted to any payer.
          </p>
        ) : loaded.kind === 'database_unavailable' ? (
          <p role="alert" className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning">
            Database unavailable: the API is running but probe status could not be read. Nothing was submitted to any payer.
          </p>
        ) : loaded.status.probes.length === 0 ? (
          <p className="text-sm text-muted">No probes yet. Submit one to exercise the queue and worker.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <caption className="sr-only">Most recent synthetic pilot probes</caption>
              <thead className="border-b border-line text-muted">
                <tr>
                  <th className="py-2 pr-4 font-medium">Probe</th>
                  <th className="py-2 pr-4 font-medium">Status</th>
                  <th className="py-2 pr-4 font-medium">Created</th>
                  <th className="py-2 pr-4 font-medium">Worker result</th>
                </tr>
              </thead>
              <tbody>
                {loaded.status.probes.map((probe) => (
                  <tr key={probe.probeId} className="border-b border-line last:border-0">
                    <td className="py-2 pr-4 font-mono text-xs">{probe.probeId}</td>
                    <td className="py-2 pr-4">{probe.status === 'completed' ? 'Completed by worker' : 'Queued'}</td>
                    <td className="py-2 pr-4 tabular-nums">{probe.createdAt}</td>
                    <td className="py-2 pr-4 font-mono text-xs">
                      {probe.workerResult === null ? 'Pending' : `${probe.workerResult.outcome} ${probe.workerResult.probeDigest.slice(0, 12)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {status !== null && (
          <p className="text-xs text-muted">
            Database checked at {status.database.checkedAt}. Build {status.build.revision}.
          </p>
        )}
      </section>
    </main>
  );
}
