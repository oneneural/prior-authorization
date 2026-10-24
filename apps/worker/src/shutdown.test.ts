import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { DRAIN_DEADLINE_MS, EXIT_DEADLINE_MS } from './shutdown.js';

// The same budget as container test group 6, read from the repository files the
// image is built from, so a change is caught without Docker.
const repoFile = (path: string) => readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8');
const timeoutDown = (service: string) => Number(repoFile(`docker/rootfs/etc/s6-overlay/s6-rc.d/${service}/timeout-down`));

describe('worker shutdown budget', () => {
  it('leaves at least 5 s between the drain deadline and the forced exit', () => {
    expect(EXIT_DEADLINE_MS - DRAIN_DEADLINE_MS).toBeGreaterThanOrEqual(5_000);
  });

  it('forces the exit before s6 stops waiting for the worker', () => {
    expect(EXIT_DEADLINE_MS).toBeLessThan(timeoutDown('worker'));
  });

  it('fits the worst-case shutdown 5 s inside the app stop grace period', () => {
    // Services stop one after another; each may take up to its s6 timeout-down,
    // then s6-overlay waits S6_KILL_GRACETIME before killing what is left.
    const steps = ['watchdog', 'drain', 'worker', 'web', 'api'].map(timeoutDown);
    for (const step of steps) {
      expect(step).toBeGreaterThan(0);
    }
    const killGrace = Number(/S6_KILL_GRACETIME=(\d+)/.exec(repoFile('Dockerfile'))?.[1]);
    expect(killGrace).toBeGreaterThan(0);
    const appService = /\n {2}app:\n([\s\S]*?)\n\S/.exec(repoFile('compose.yaml'))?.[1] ?? '';
    const stopGraceMs = Number(/\n {4}stop_grace_period: (\d+)s\n/.exec(appService)?.[1]) * 1000;
    expect(stopGraceMs).toBeGreaterThan(0);
    const worstCase = steps.reduce((sum, step) => sum + step, 0) + killGrace;
    expect(worstCase).toBeLessThanOrEqual(stopGraceMs - 5_000);
  });
});
