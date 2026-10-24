import type { BamStatusSummary } from 'pg-boss';
import { describe, expect, it } from 'vitest';

import { AsyncMigrationError, waitForAsyncMigrations } from './migrate.js';

// pg-boss 12.38.0 creates no background migration on a fresh install, so the wait
// is exercised against scripted `getBamStatus()` results instead of a real upgrade.

const row = (status: BamStatusSummary['status'], count: number): BamStatusSummary => ({ status, count, lastCreatedOn: new Date(0) });

function scripted(...polls: BamStatusSummary[][]): { status: () => Promise<BamStatusSummary[]>; calls: () => number } {
  let calls = 0;
  return {
    status: () => Promise.resolve(polls[Math.min(calls++, polls.length - 1)] ?? []),
    calls: () => calls,
  };
}

describe('waiting for pg-boss background migrations', () => {
  it('returns at once when nothing is pending or running', async () => {
    const source = scripted([row('completed', 3)]);
    const log: string[] = [];
    await waitForAsyncMigrations(source.status, (message) => log.push(message), { intervalMs: 1 });
    expect(source.calls()).toBe(1);
    expect(log).toEqual([]);
  });

  it('keeps polling until pending and running commands have finished', async () => {
    const source = scripted([row('pending', 2)], [row('in_progress', 1), row('completed', 1)], [row('completed', 2)]);
    const log: string[] = [];
    await waitForAsyncMigrations(source.status, (message) => log.push(message), { intervalMs: 1 });
    expect(source.calls()).toBe(3);
    expect(log).toEqual(['waiting for 2 queue background migration command(s)', 'queue background migrations finished']);
  });

  it('fails the run when a command failed', async () => {
    const source = scripted([row('completed', 1), row('failed', 1)]);
    await expect(waitForAsyncMigrations(source.status, () => undefined, { intervalMs: 1 })).rejects.toThrow(AsyncMigrationError);
  });

  it('fails the run when commands outlast the deadline', async () => {
    const source = scripted([row('in_progress', 1)]);
    await expect(waitForAsyncMigrations(source.status, () => undefined, { intervalMs: 1, timeoutMs: 20 })).rejects.toThrow(
      'did not finish in time',
    );
  });
});
