import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';

import {
  AdmissionRefused, attemptCeilingUnits, LIVE_MODEL_DEFAULTS, OPUS_5_5_TARIFF, usageUnits, type AdmissionPort, type LiveModelClient, type LiveSettings,
} from '@pa/agents';
import type { BudgetRunSummary } from '@pa/contracts';

import { sequencedAdmission } from './live-admission-client.js';
import { buildLiveReport, formatLiveReport, LIVE_SNAPSHOTS, LIVE_SUITE_CASES, liveRunFailures, runLiveEvaluation } from './live-claude.js';

// Zero-cost check of the live evaluation path: a fake Messages client plays a
// small reader through the real graph, gates and report, with no network. The
// fake admission transport below only records calls; the real ledger and its
// routes are tested in apps/api.

const settings: LiveSettings = LIVE_MODEL_DEFAULTS;
const CEILING = attemptCeilingUnits(OPUS_5_5_TARIFF, LIVE_MODEL_DEFAULTS.maxOutputTokens);

/** Grants while the cap allows another ceiling; a real API also holds unknown usage, which this suite never produces. */
function fakeAdmission(capUnits: number) {
  const attempts = new Map<string, { turn: number; reserved: number; actual: number | null; state: string }>();
  const committed = () => [...attempts.values()].reduce((total, item) => total + (item.actual ?? (item.state === 'released' ? 0 : item.reserved)), 0);
  const port: AdmissionPort = {
    reserve: (request) => {
      if (committed() + CEILING > capUnits) return Promise.reject(new AdmissionRefused('budget_exhausted', 'cap'));
      const attemptId = crypto.randomUUID();
      attempts.set(attemptId, { turn: request.turn, reserved: CEILING, actual: null, state: 'reserved' });
      return Promise.resolve({ attemptId, state: 'reserved', reservedUnits: CEILING, replayed: false });
    },
    dispatch: (attemptId) => { attempts.get(attemptId)!.state = 'dispatching'; return Promise.resolve({ attemptId, state: 'dispatching', writerGeneration: 1 }); },
    release: (attemptId) => { attempts.get(attemptId)!.state = 'released'; return Promise.resolve({ attemptId, state: 'released', actualUnits: null }); },
    reconcile: (attemptId, report) => {
      const item = attempts.get(attemptId)!;
      item.state = 'reconciled';
      item.actual = usageUnits(OPUS_5_5_TARIFF, report.usage);
      return Promise.resolve({ attemptId, state: 'reconciled', actualUnits: item.actual });
    },
    unknown: (attemptId) => { attempts.get(attemptId)!.state = 'unknown'; return Promise.resolve({ attemptId, state: 'unknown', actualUnits: null }); },
  };
  const summary = (runId: string): BudgetRunSummary => ({
    runId, capUnits, state: 'stopped', attempts: attempts.size, runCommittedUnits: committed(), dayCommittedUnits: committed(), lifetimeCommittedUnits: committed(),
    heldUnits: [...attempts.values()].filter((item) => item.state === 'unknown' || item.state === 'dispatching').reduce((total, item) => total + item.reserved, 0),
  });
  return { port: sequencedAdmission(port), attempts, summary };
}
const usage = { input_tokens: 1200, output_tokens: 300, cache_creation_input_tokens: 0, cache_read_input_tokens: 800 };

function reply(content: unknown[], stop_reason: Anthropic.StopReason): Anthropic.Message {
  return { id: 'msg_fake', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content, stop_reason, stop_sequence: null, stop_details: null, usage } as unknown as Anthropic.Message;
}

/** Lists, reads the first readable order, proposes its status, then finishes; also captures every payload it reads. */
function fakeReader(seenPayloads: string[]): LiveModelClient {
  return {
    create(params) {
      const results = params.messages.flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        .filter((block): block is Anthropic.ToolResultBlockParam => block.type === 'tool_result')
        .map((block) => JSON.parse(block.content as string) as { outcome: string; result: Record<string, unknown> | null });
      const call = (name: string, input: unknown) => Promise.resolve(reply([{ type: 'tool_use', id: `toolu_${results.length}`, name, input }], 'tool_use'));
      if (results.length === 0) return call('list_documents', {});
      if (results.length === 1) {
        const docs = (results[0]!.result?.documents ?? []) as { documentId: string; version: number; kind: string; readable: boolean }[];
        const order = docs.find((doc) => doc.kind === 'order' && doc.readable);
        if (order === undefined) return Promise.resolve(reply([{ type: 'text', text: 'nothing to read' }], 'end_turn'));
        return call('read_document', { documentId: order.documentId, version: order.version });
      }
      if (results.length === 2 && results[1]!.outcome === 'ok') {
        const read = results[1]!.result as { documentId: string; version: number; contentHash: string; payload: string };
        seenPayloads.push(read.payload);
        const status = (JSON.parse(read.payload) as { status: string }).status;
        return call('propose_facts', { candidates: [{ field: 'order.status', documentId: read.documentId, documentVersion: read.version, locator: '/status', value: status, originalText: status, confidence: 0.9, sourceContentHash: read.contentHash }] });
      }
      return Promise.resolve(reply([{ type: 'text', text: 'done' }], 'end_turn'));
    },
  };
}

describe('live evaluation with a fake client', () => {
  it('covers the dispatch subset', () => {
    expect(LIVE_SUITE_CASES).toHaveLength(14);
    expect(LIVE_SNAPSHOTS.length).toBeLessThanOrEqual(8);
    expect(LIVE_SNAPSHOTS).toEqual(expect.arrayContaining(['F01', 'F02', 'F08a', 'F23']));
  });

  it('runs real graphs and gates, reconciles cost and writes a content-free report', async () => {
    const seen: string[] = [];
    const admission = fakeAdmission(10 * 10_000_000);
    const runs = await runLiveEvaluation({ settings, admission: admission.port, clientFactory: () => fakeReader(seen), cases: ['F01', 'H01', 'F17a'] });
    expect(runs.map((run) => run.caseId)).toEqual(['H01', 'F17a', 'F01']);
    for (const run of runs) {
      expect(run.problems).toEqual([]);
      expect(run.graph.stopReason).toBe('finished');
      expect(run.graph.proposals.map((proposal) => proposal.code ?? 'valid')).toEqual(['valid']);
      expect(run.calls.map((call) => call.outcome)).toEqual(['tool_use', 'tool_use', 'tool_use', 'finish']);
    }
    // F17a's authored expectation is for a scripted injection; the live difference is a note, not a gate failure.
    expect(runs.find((run) => run.caseId === 'F17a')!.notes!.length).toBeGreaterThan(0);
    expect(admission.attempts.size).toBe(12);
    // Attempts are numbered across the run, so each case's turn 0 is a distinct attempt identity.
    expect([...admission.attempts.values()].map((item) => item.turn)).toEqual([...Array(12).keys()]);

    const report = buildLiveReport(runs, {
      runId: 'eval-fake', label: 'fake', settings, revision: 'a'.repeat(40), dirtyPaths: 0, startedAt: '2026-10-21T00:00:00.000Z', finishedAt: '2026-10-21T00:01:00.000Z',
      ledger: admission.summary('eval-fake'), promptNote: 'fake client',
    });
    // Exact units: 1200 x 40 + 800 x 2 + 300 x 200 = 109,600 units per call.
    const perCallUnits = 1200 * 40 + 800 * 2 + 300 * 200;
    expect(runs.flatMap((run) => run.calls).map((call) => call.actualUnits)).toEqual(Array(12).fill(perCallUnits));
    expect(report.totals.provider.reconciledUsd).toBeCloseTo((12 * perCallUnits) / 1e7, 12);
    expect(report.ledger.runCommittedUsd).toBeCloseTo((12 * perCallUnits) / 1e7, 12);
    expect(report.schemaVersion).toBe('pa.live-eval-report.v2');
    expect(report.totals.provider.refusals).toEqual([0, 12]);
    expect(report.totals.live.supportedEvidence).toEqual([3, 3]);
    expect(report.totals.live.falseReady[0]).toBe(0);
    expect(report.label).toBe('live_claude');
    expect(liveRunFailures(report)).toEqual([]);
    const text = JSON.stringify(report) + formatLiveReport(report);
    expect(seen).toHaveLength(3);
    for (const payload of seen) {
      const body = JSON.parse(payload) as { beneficiary: { name: string | null; identifier: string | null } };
      expect(text).not.toContain(payload);
      for (const value of [body.beneficiary.name, body.beneficiary.identifier]) if (value !== null) expect(text).not.toContain(value);
    }
    expect(text).not.toContain('nothing to read');
    expect(formatLiveReport(report)).toContain('| F01 | snapshot | ready_for_review | ready_for_review | finished | list_documents > read_document > propose_facts > finish | fact:valid | 0/0 |');
  });

  it('records a budget refusal as a stopped run without spending more', async () => {
    const admission = fakeAdmission(100_000);
    let requests = 0;
    const runs = await runLiveEvaluation({ settings, admission: admission.port, clientFactory: () => ({ create: (params, signal) => { requests += 1; return fakeReader([]).create(params, signal); } }), cases: ['F01'] });
    expect(runs[0]!.graph.stopReason).toBe('provider_unavailable');
    expect(runs[0]!.calls.map((call) => call.outcome)).toEqual(['budget_refused']);
    expect(admission.attempts.size).toBe(0);
    expect(requests).toBe(0);
    const report = buildLiveReport(runs, {
      runId: 'eval-tiny', label: 'tiny', settings, revision: 'a'.repeat(40), dirtyPaths: 0, startedAt: '2026-10-21T00:00:00.000Z', finishedAt: '2026-10-21T00:01:00.000Z',
      ledger: admission.summary('eval-tiny'), promptNote: 'fake client',
    });
    expect(report.cases[0]!.gateProblems).toEqual([]);
    expect(liveRunFailures(report)).toEqual(['F01: stopped as provider_unavailable']);
  });

  it('refuses case IDs outside the subset', async () => {
    await expect(runLiveEvaluation({ settings, admission: fakeAdmission(0).port, clientFactory: () => fakeReader([]), cases: ['F07a'] })).rejects.toThrow('not in the live subset');
  });
});
