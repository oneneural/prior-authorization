import type { SessionActor } from '@pa/contracts';

import { agentCapability, agentRun, agentRuns } from '../lib/cases';
import { REJECTION_LABELS, sourceHref } from '../lib/labels';
import { AgentReview } from './agent-review';
import { CommandButton } from './command-button';

const RECORDING = 'missing-order-investigation';
const usd = (value: number) => `USD ${value.toFixed(2)}`;

/**
 * Investigation runs for one case. Recorded runs replay a scripted fixture.
 * Live runs exist only when live mode was selected explicitly and the API's
 * accounting ledger is open; each attempt is admitted and budgeted by the API.
 * Proposals are evidence candidates with their validation outcome; nothing
 * here changes the deterministic assessment.
 */
export async function AgentPanel({ caseId, revision, actor, bound }: { caseId: string; revision: number; actor: SessionActor; bound: boolean }) {
  const capability = await agentCapability();
  const { runs } = await agentRuns(caseId);
  const latest = runs[0] === undefined ? null : await agentRun(caseId, runs[0].runId);
  const valid = latest?.proposals.filter((item) => item.status === 'valid' && item.review === 'pending') ?? [];
  const recorded = capability.graphProvider !== 'off';
  const live = capability.live;

  return (
    <section aria-labelledby="agent-heading" className="flex flex-col gap-3 rounded-xl border border-line bg-panel p-4">
      <h2 id="agent-heading" className="text-lg font-semibold">
        {capability.graphProvider === 'live' ? 'Agent investigation (recorded or live Claude)' : 'Recorded agent investigation (scripted fixture)'}
      </h2>
      <p className="text-sm text-muted">
        {capability.graphProvider === 'live'
          ? 'A recorded run replays a scripted fixture. A live run sends synthetic case text to Claude through the API, which reserves budget before every model attempt. '
          : 'Replays a recorded investigation; no live model call is made. '}
        Proposals are candidates checked against the cited source and never replace the rules assessment.
      </p>
      <p className="w-fit rounded-md border border-line px-3 py-1 font-mono text-sm" data-testid="agent-capability">
        Recorded runs: {recorded ? 'enabled' : 'disabled by configuration'}.{' '}
        {capability.graphProvider === 'live'
          ? `Live Claude: ${live.enabled ? 'available' : `unavailable (${live.reason.replaceAll('_', ' ')})`}; caps per run ${usd(live.runBudgetUsd)}, per UTC day ${usd(live.dailyBudgetUsd)}, total ${usd(live.totalBudgetUsd)}${live.remaining === null ? '' : `; remaining today ${usd(live.remaining.dayUsd)}, lifetime ${usd(live.remaining.lifetimeUsd)}`}.`
          : 'Live Claude: disabled (budget 0).'}
      </p>
      {recorded && actor.role === 'fixture_operator' && (
        bound
          ? (
            <div className="flex flex-wrap gap-2">
              <CommandButton path={`${encodeURIComponent(caseId)}/agent-runs`} body={{ expectedRevision: revision, provider: 'recorded', recordingId: RECORDING }} label="Start recorded run" tone="secondary" />
              {live.enabled && (
                <CommandButton
                  path={`${encodeURIComponent(caseId)}/agent-runs`} body={{ expectedRevision: revision, provider: 'anthropic' }} label="Start live Claude run (paid)" tone="secondary"
                  confirm={`Start a paid live Claude run? Each model attempt holds ${usd(live.attemptReservationUsd)} until its usage is reconciled.`}
                />
              )}
            </div>
          )
          : <p className="text-sm text-muted">A run needs a current assessed packet.</p>
      )}
      {latest === null ? (
        <p className="text-sm text-muted">No recorded runs for this case.</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p className="text-sm">
            Latest run {latest.run.runId.slice(0, 8)} ({latest.run.label.replaceAll('_', ' ')}): <strong>{latest.run.state.replaceAll('_', ' ')}</strong> on revision {latest.run.caseRevision}
            {latest.run.stopReason === null ? '' : `, stopped: ${latest.run.stopReason.replaceAll('_', ' ')}`}
            {latest.run.failureCode === null ? '' : `, failure: ${latest.run.failureCode.replaceAll('_', ' ')}`}.
          </p>
          <ul className="flex flex-col gap-2 text-sm">
            {latest.proposals.map((proposal, index) => (
              <li key={proposal.proposalId} className="rounded-lg border border-line p-2">
                <p>
                  Proposal {index + 1}: {proposal.kind === 'fact' ? 'source-linked fact' : 'missing-document request'}.{' '}
                  <strong>{proposal.status === 'valid' ? 'Valid against the cited source' : (REJECTION_LABELS[proposal.code ?? ''] ?? `Rejected: ${proposal.code}`)}</strong>.
                  {' '}Review: {proposal.review.replaceAll('_', ' ')}.
                </p>
                {proposal.payload?.fact !== undefined && (
                  <p>
                    {proposal.payload.fact.field}: “{proposal.payload.fact.originalText}”{' '}
                    <a className="text-accent underline" href={sourceHref(caseId, proposal.payload.fact.documentId, proposal.payload.fact.documentVersion, proposal.payload.fact.locator)}>
                      Citation: {proposal.payload.fact.documentId} version {proposal.payload.fact.documentVersion} at {proposal.payload.fact.locator}
                    </a>
                  </p>
                )}
                {proposal.payload?.templateId !== undefined && <p>Request template {proposal.payload.templateId} for finding {proposal.payload.findingId}; it would become an ordinary draft needing local approval.</p>}
              </li>
            ))}
          </ul>
          {latest.run.state === 'awaiting_review' && valid.length > 0 && (
            actor.role === 'fixture_administrative_reviewer'
              ? <AgentReview caseId={caseId} runId={latest.run.runId} proposalIds={valid.map((item) => item.proposalId)} />
              : <p className="text-sm text-muted">Awaiting the fixture administrative reviewer.</p>
          )}
          {actor.role === 'fixture_operator' && ['queued', 'running', 'resume_queued', 'resuming', 'awaiting_review'].includes(latest.run.state) && (
            <CommandButton path={`${encodeURIComponent(caseId)}/agent-runs/${latest.run.runId}/cancel`} body={{}} label="Cancel this run" tone="secondary" confirm="Cancel this run? Its proposals stay recorded but can no longer be reviewed; any held model spend stays in the ledger." />
          )}
          {latest.run.outcome !== null && <p className="text-sm text-muted">Outcome: {JSON.stringify(latest.run.outcome)}</p>}
        </div>
      )}
    </section>
  );
}
