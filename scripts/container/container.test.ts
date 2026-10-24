// Container tests for the app image and Compose topology. Requires
// Docker with Compose; builds the image as prior-authorization-app:ctest and runs
// the stack as the prior-authorization-ctest project on 127.0.0.1:36105, removing
// only that project's containers, network, volumes and test images at the end.
// Each group starts from, and leaves behind, a healthy stack, so one group can
// run alone: pnpm test:container -t 'container 6\.'. Group 13 scans the build
// output and the logs of every container the run created, so it covers the
// other groups only in a full run.
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest';

import {
  BASE_URL,
  compose,
  composeResult,
  containerId,
  type Context,
  dieEvents,
  dockerExec,
  HOST_PORT,
  http,
  IMAGE,
  inspect,
  keepContainerLogs,
  lockTable,
  logs,
  nodeInContainer,
  note,
  prepareContext,
  probeStatus,
  PROJECT,
  psql,
  removeContext,
  Scanner,
  scanExport,
  scanSavedImage,
  servedFiles,
  servicePid,
  sh,
  shResult,
  submitProbe,
  timestampedLogs,
  VIOLATION_IMAGE,
  waitFor,
  waitHealthy,
  writeContextFile,
} from './harness.js';

const CREDENTIAL = /^(DATABASE_URL_|WORKER_SERVICE_TOKEN|POSTGRES_PASSWORD|BETTER_AUTH_SECRET)/;
const nowSeconds = () => Math.floor(Date.now() / 1000);

let context: Context;

/** Brings the default stack back (valid configuration, no job delay) and waits until healthy. */
async function ensureDefaultStack(): Promise<void> {
  await compose(context, ['up', '-d', '--wait', '--no-build'], { timeoutMs: 300_000 });
  await waitHealthy(context);
}

/** Recreates only the app container with extra environment and waits until healthy. */
async function recreateApp(env: Record<string, string> = {}): Promise<string> {
  await compose(context, ['up', '-d', '--wait', '--no-deps', '--no-build', 'app'], { env, timeoutMs: 300_000 });
  await waitHealthy(context);
  return containerId(context, 'app');
}

async function readiness(): Promise<{ status: number; reasons: string[] }> {
  const result = await http('/api/health/ready');
  return { status: result.status, reasons: (result.json as { reasons?: string[] } | undefined)?.reasons ?? [] };
}

async function submitAndComplete(label: string, timeoutMs = 60_000): Promise<string> {
  const created = await submitProbe(label);
  expect(created.status).toBe(201);
  const probeId = (created.json as { probe: { probeId: string } }).probe.probeId;
  await waitFor(`probe ${label} completed`, async () => ((await probeStatus(probeId)) === 'completed' ? true : undefined), timeoutMs);
  return probeId;
}

beforeAll(async () => {
  context = await prepareContext();
  note(`context ${context.dir}, revision ${context.revision}`);
  const started = Date.now();
  const build = await composeResult(context, ['build', 'app'], { timeoutMs: 1_200_000 });
  context.buildOutput = build.stdout + build.stderr;
  if (build.code !== 0) {
    throw new Error(`image build failed:\n${build.stderr.slice(-4_000)}`);
  }
  note(`image ${IMAGE} built in ${Math.round((Date.now() - started) / 1000)} s`);
  const fresh = Date.now();
  await ensureDefaultStack();
  note(`fresh project healthy in ${Math.round((Date.now() - fresh) / 1000)} s`);
});

afterAll(async () => {
  if (context !== undefined) {
    await composeResult(context, ['down', '-v', '--remove-orphans'], { timeoutMs: 300_000 });
  }
  await shResult('docker', ['image', 'rm', '-f', IMAGE, VIOLATION_IMAGE]);
  await removeContext(context);
});

describe('container', () => {
  it('container 1. fresh project: init completes, app is healthy and serves the labelled page on loopback only', async () => {
    const init = await inspect(await containerId(context, 'init'));
    expect(init.State.Status).toBe('exited');
    expect(init.State.ExitCode).toBe(0);
    const initLogs = await logs(init.Id);
    expect(initLogs).toMatch(/init: (created database prior_authorization and roles|database prior_authorization exists; roles and grants reapplied)/);
    expect(initLogs).toContain('init: complete');

    const app = await waitHealthy(context);
    expect(app.HostConfig.PortBindings).toEqual({ '3105/tcp': [{ HostIp: '127.0.0.1', HostPort: String(HOST_PORT) }] });
    expect(app.Config.Labels['org.opencontainers.image.revision']).toBe(context.revision);
    const db = await inspect(await containerId(context, 'db'));
    expect(db.HostConfig.PortBindings ?? {}).toEqual({});

    const status = await http('/api/status');
    expect(status.status).toBe(200);
    expect(status.json).toMatchObject({ appId: 'prior-authorization', build: { revision: context.revision }, modes: { data: 'fixture' } });
    // The workbench needs a session, so the root page redirects to sign-in; the
    // session-free pilot page shows the notice and the running build.
    const root = await http('/', { redirect: 'manual' });
    expect([302, 303, 307, 308]).toContain(root.status);
    expect(new URL(root.location ?? '', BASE_URL).pathname).toBe('/login');
    const page = await http('/pilot');
    expect(page.status).toBe(200);
    expect(page.text).toContain('Synthetic data. Administrative review only. No payer submission.');
    expect(page.text).toContain(context.revision);
    expect(await readiness()).toEqual({ status: 200, reasons: [] });
    expect((await http('/api/health/live')).json).toEqual({ live: true });

    // The published port answers on loopback only.
    const published = await sh('docker', ['port', app.Id, '3105/tcp']);
    expect(published.trim().split('\n')).toEqual([`127.0.0.1:${HOST_PORT}`]);

    const probeId = await submitAndComplete('ctest fresh project');
    note(`fresh project probe ${probeId} completed through ${BASE_URL}`);
  });

  it('container 2. killing web, API or worker stops the container nonzero and the restart policy recovers it', async () => {
    await ensureDefaultStack();
    for (const service of ['web', 'api', 'worker']) {
      const before = await inspect(await containerId(context, 'app'));
      const pid = await servicePid(before.Id, service);
      expect(pid, `${service} process`).toBeTypeOf('number');
      const since = nowSeconds() - 1;
      const killedAt = Date.now();
      await dockerExec(before.Id, ['/bin/sh', '-c', `kill -KILL ${pid}`]);
      const [died] = await waitFor(`${service} kill to stop the container`, async () => {
        const events = await dieEvents(before.Id, since);
        return events.length > 0 ? events : undefined;
      }, 60_000);
      expect(died!.exitCode, `${service} exit code`).toBe(137);
      const recovered = await waitHealthy(context);
      expect(recovered.RestartCount).toBe(before.RestartCount + 1);
      const output = await logs(before.Id, new Date(killedAt - 1_000).toISOString());
      expect(output).toContain(`pa: stopping the container with exit code 137: essential service ${service} stopped unexpectedly (killed by signal 9)`);
      note(`kill ${service}: exit ${died!.exitCode} after ${Math.round(died!.time * 1000 - killedAt)} ms, healthy again after ${Math.round((Date.now() - killedAt) / 1000)} s`);
    }
  });

  it('container 3. an invalid configuration exits with a clear, value-free error and never becomes healthy', async () => {
    await ensureDefaultStack();
    const since = nowSeconds() - 1;
    await compose(context, ['up', '-d', '--no-deps', '--no-build', 'app'], { env: { DATA_MODE: 'live' } });
    const id = await containerId(context, 'app');
    const deadline = Date.now() + 25_000;
    while (Date.now() < deadline) {
      const info = await inspect(id);
      expect(info.State.Health?.Status).not.toBe('healthy');
      await delay(1_000);
    }
    const events = await dieEvents(id, since);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((event) => event.exitCode === 1)).toBe(true);
    const output = await logs(id);
    expect(output).toContain('DATA_MODE=live is not supported by this build (supported: fixture)');
    const scanner = new Scanner(context.needles);
    scanner.text(output, 'invalid-configuration logs');
    expect(scanner.findings).toEqual([]);
    note(`invalid configuration: ${events.length} exit(s) with code 1 in 25 s, never healthy`);
    await recreateApp();
  });

  it('container 4. a heartbeat from a previous worker process does not count, and a stalled worker trips the watchdog', async () => {
    await ensureDefaultStack();
    const app = await inspect(await containerId(context, 'app'));
    const since = nowSeconds() - 1;

    // Stop the worker and restart the API on purpose (s6 marks both wanted down,
    // so neither stops the container). The worker's last heartbeat row stays fresh
    // in the database, but the new API process has received none.
    await dockerExec(app.Id, ['/command/s6-svc', '-wD', '-d', '/run/service/worker']);
    await dockerExec(app.Id, ['/command/s6-svc', '-wD', '-d', '/run/service/api']);
    await dockerExec(app.Id, ['/command/s6-svc', '-wU', '-u', '/run/service/api']);
    const missing = await waitFor('readiness from the new API process', async () => {
      const result = await readiness();
      return result.reasons.length > 0 ? result : undefined;
    }, 20_000, 250);
    const rowAge = Number(await psql(context, 'SELECT extract(epoch FROM now() - max(last_seen_at)) FROM pa_worker.worker_heartbeats'));
    expect(missing).toEqual({ status: 503, reasons: ['worker_heartbeat_missing'] });
    expect(rowAge).toBeLessThan(15);
    note(`previous-process heartbeat row ${rowAge.toFixed(1)} s old; readiness reported worker_heartbeat_missing`);
    await dockerExec(app.Id, ['/command/s6-svc', '-u', '/run/service/worker']);
    await waitFor('readiness after the worker returns', async () => ((await readiness()).status === 200 ? true : undefined), 30_000);
    expect(await dieEvents(app.Id, since)).toEqual([]);

    // A stalled worker: SIGSTOP freezes it without exiting.
    const pid = await servicePid(app.Id, 'worker');
    const stalledSince = nowSeconds() - 1;
    const stoppedAt = Date.now();
    await dockerExec(app.Id, ['/bin/sh', '-c', `kill -STOP ${pid}`]);
    const [died] = await waitFor('the watchdog to stop the container', async () => {
      const events = await dieEvents(app.Id, stalledSince);
      return events.length > 0 ? events : undefined;
    }, 120_000);
    const elapsed = died!.time - stoppedAt / 1000;
    expect(died!.exitCode).toBe(124);
    expect(elapsed).toBeLessThan(65);
    const output = await logs(app.Id, new Date(stoppedAt).toISOString());
    expect(output).toMatch(/watchdog: readiness failed for \d+ s \(worker_heartbeat_stale\)/);
    expect(output).toContain('pa: stopping the container with exit code 124');
    note(`stalled worker: container stopped with 124 after ${elapsed.toFixed(1)} s (bound 65 s)`);
    await waitHealthy(context);
  });

  it('container 5. a database outage reports not ready with a reason, does not restart the app, and recovers', async () => {
    await ensureDefaultStack();
    const app = await inspect(await containerId(context, 'app'));
    const pids = await Promise.all(['web', 'api', 'worker'].map((service) => servicePid(app.Id, service)));
    // The watchdog logs only state changes, and can log the pause while `compose
    // stop` is still running. So the log window starts at its current state, taken
    // before the stop: its latest transition in this boot must be the ready one
    // (which also shows it is armed), and the pause after it belongs to this outage.
    const ready = await waitFor('the watchdog to report ready in the current boot', async () => {
      const transitions = (await timestampedLogs(app.Id, app.State.StartedAt)).filter((line) => /"service":"pa-watchdog","message":"(watchdog started|readiness [^"]+)"/.test(line.text));
      const last = transitions.at(-1);
      return last !== undefined && last.text.includes('"message":"readiness ready"') ? last : undefined;
    }, 30_000);
    const since = nowSeconds() - 1;
    await compose(context, ['stop', 'db']);
    const stoppedAt = Date.now();
    // Restore the database for the following groups even when an assertion fails.
    // `compose up --wait` would reject the app while it is still unhealthy, so this
    // starts db alone (a no-op if it already runs) and waits for readiness and
    // Docker health. Vitest reports a failure here next to the test's own failure.
    onTestFailed(async () => {
      await compose(context, ['start', 'db']);
      await waitFor('readiness after restoring the database', async () => ((await readiness()).status === 200 ? true : undefined), 90_000);
      const restored = await waitHealthy(context, 60_000);
      note(`after the failure, the database was restored: ready and healthy, restart count ${restored.RestartCount} (before the outage ${app.RestartCount})`);
    });
    const outage = await waitFor('database_unavailable readiness', async () => {
      const result = await readiness();
      return result.reasons.includes('database_unavailable') ? result : undefined;
    }, 30_000);
    expect(outage.status).toBe(503);
    const status = await http('/api/status');
    expect(status.status).toBe(503);
    expect(status.json).toMatchObject({ error: { code: 'database_unavailable' } });
    expect((await http('/pilot')).text).toContain('Database unavailable: the API is running but probe status could not be read.');
    expect((await submitProbe('ctest during outage')).status).toBe(503);

    // Hold the outage past the watchdog's 30-second hang limit.
    await delay(45_000);
    expect(await dieEvents(app.Id, since)).toEqual([]);
    // The watchdog paused because it could not reach the database itself, at the
    // address the API's launcher derived from the API's database URL.
    expect(await logs(app.Id)).toMatch(/"message":"watchdog started",[^}]*"databaseAddress":"db:5432"/);
    expect(await logs(app.Id, ready.time)).toMatch(/"message":"readiness paused for database outage","reasons":\[[^\]]*"database_unavailable"[^\]]*\],"database":"db:5432 [^"]+"/);
    const during = await inspect(app.Id);
    expect(during.RestartCount).toBe(app.RestartCount);
    expect(await Promise.all(['web', 'api', 'worker'].map((service) => servicePid(app.Id, service)))).toEqual(pids);
    note(`database outage held ${Math.round((Date.now() - stoppedAt) / 1000)} s: reasons ${(await readiness()).reasons.join(',')}, no restart`);

    await compose(context, ['start', 'db']);
    const restartedAt = Date.now();
    await waitFor('readiness after the database returns', async () => ((await readiness()).status === 200 ? true : undefined), 90_000);
    note(`readiness recovered ${Math.round((Date.now() - restartedAt) / 1000)} s after the database started`);
    await submitAndComplete('ctest after outage');
    // Docker's health status follows on its next check, without a restart.
    const healthy = await waitHealthy(context, 60_000);
    expect(healthy.RestartCount).toBe(app.RestartCount);
    note(`Docker health back to healthy ${Math.round((Date.now() - restartedAt) / 1000)} s after the database started`);
    expect(await dieEvents(app.Id, since)).toEqual([]);
  });

  describe('container 6. SIGTERM drain', () => {
    /** The worker's compiled drain and forced-exit deadlines in the image. */
    function workerShutdown(id: string): Promise<{ drainDeadlineMs: number; exitDeadlineMs: number }> {
      return nodeInContainer(
        id,
        "const m = await import('/app/apps/worker/dist/shutdown.js'); console.log(JSON.stringify({ drainDeadlineMs: m.DRAIN_DEADLINE_MS, exitDeadlineMs: m.EXIT_DEADLINE_MS }));",
      );
    }

    /** Submits a probe and waits until the worker has started its job (the barrier). */
    async function activeJob(id: string, label: string): Promise<{ probeId: string; jobId: string }> {
      const created = await submitProbe(label);
      expect(created.status).toBe(201);
      const probeId = (created.json as { probe: { probeId: string } }).probe.probeId;
      const jobId = await waitFor('the pilot job to start', async () => {
        const match = /"message":"pilot job started","jobId":"([0-9a-f-]+)"/.exec(await logs(id));
        return match?.[1];
      }, 30_000, 200);
      return { probeId, jobId };
    }

    /** Stops the app while probing the public routes; returns what the probes saw. */
    async function stopWhileProbing(): Promise<{ stopMs: number; refused: number; acceptedAfterRefusal: number; readinessShuttingDown: boolean }> {
      const started = Date.now();
      const stop = compose(context, ['stop', 'app'], { timeoutMs: 120_000 }).then(() => Date.now() - started);
      let done = false;
      void stop.finally(() => {
        done = true;
      });
      let refused = 0;
      let acceptedAfterRefusal = 0;
      let readinessShuttingDown = false;
      while (!done) {
        try {
          const result = await submitProbe('ctest during shutdown');
          if (result.status === 503 && (result.json as { error?: { code?: string } }).error?.code === 'shutting_down') {
            refused += 1;
          } else if (result.status === 201 && refused > 0) {
            acceptedAfterRefusal += 1;
          }
          if ((await readiness()).reasons.includes('shutting_down')) {
            readinessShuttingDown = true;
          }
        } catch {
          // The web server has stopped listening.
        }
        await delay(200);
      }
      return { stopMs: await stop, refused, acceptedAfterRefusal, readinessShuttingDown };
    }

    it('lets an active job finish through the internal route, refuses new work and exits cleanly', async () => {
      await ensureDefaultStack();
      const id = await recreateApp({ PA_CTEST_JOB_DELAY_MS: '8000', PA_CTEST_WORKER_CONCURRENCY: '1' });
      const { probeId, jobId } = await activeJob(id, 'ctest drain finishes');
      const { drainDeadlineMs } = await workerShutdown(id);
      const observed = await stopWhileProbing();
      const info = await inspect(id);
      expect(info.State.ExitCode).toBe(0);
      expect(observed.refused).toBeGreaterThan(0);
      expect(observed.acceptedAfterRefusal).toBe(0);
      expect(observed.readinessShuttingDown).toBe(true);
      const output = await logs(id);
      const draining = output.indexOf('API draining: readiness false, new submissions refused');
      expect(draining).toBeGreaterThan(-1);
      expect(output.indexOf(`"message":"pilot job processed","jobId":"${jobId}"`)).toBeGreaterThan(draining);
      expect(output).toContain('"message":"worker drained"');
      expect(output.match(/"message":"pilot job started"/g)).toHaveLength(1);
      expect(await psql(context, `SELECT status FROM pa_app.pilot_probes WHERE probe_id = '${probeId}'`)).toBe('completed');
      expect(observed.stopMs).toBeLessThan(drainDeadlineMs);
      note(`drain within deadline: docker compose stop took ${observed.stopMs} ms, ${observed.refused} submissions refused with shutting_down`);
      await recreateApp();
    });

    it('leaves a job longer than the deadline recoverable and not completed', async () => {
      await ensureDefaultStack();
      const id = await recreateApp({ PA_CTEST_JOB_DELAY_MS: '45000', PA_CTEST_WORKER_CONCURRENCY: '1' });
      const { probeId, jobId } = await activeJob(id, 'ctest drain deadline');
      const { drainDeadlineMs, exitDeadlineMs } = await workerShutdown(id);
      const observed = await stopWhileProbing();
      const info = await inspect(id);
      expect(info.State.ExitCode).toBe(0);
      expect(observed.refused).toBeGreaterThan(0);
      expect(observed.acceptedAfterRefusal).toBe(0);
      expect(observed.stopMs).toBeGreaterThanOrEqual(drainDeadlineMs - 1_000);
      expect(observed.stopMs).toBeLessThan(60_000);
      const output = await logs(id);
      expect(output).toMatch(new RegExp(`drain deadline passed; active jobs returned to the queue for retry","[^}]*"${jobId}"`));
      // The worker used the compiled deadlines, closed its pools and stopped on
      // its own shortly after the drain deadline, before the forced exit.
      const stopping = /"message":"worker stopping: no new jobs will be claimed","signal":"SIGTERM","drainDeadlineMs":(\d+),"exitDeadlineMs":(\d+)/.exec(output);
      expect(stopping?.slice(1).map(Number)).toEqual([drainDeadlineMs, exitDeadlineMs]);
      expect(output).not.toContain('worker did not exit after its drain deadline');
      const stoppedMs = Number(/"message":"worker stopped","elapsedMs":(\d+)/.exec(output)?.[1]);
      expect(stoppedMs).toBeGreaterThanOrEqual(drainDeadlineMs);
      expect(stoppedMs).toBeLessThan(Math.min(drainDeadlineMs + 2_000, exitDeadlineMs));
      expect(await psql(context, `SELECT state FROM pgboss.job WHERE id = '${jobId}'`)).toBe('retry');
      expect(await psql(context, `SELECT status FROM pa_app.pilot_probes WHERE probe_id = '${probeId}'`)).toBe('queued');
      note(`drain past deadline: docker compose stop took ${observed.stopMs} ms; worker stopped ${stoppedMs} ms after SIGTERM (drain deadline ${drainDeadlineMs}, forced exit ${exitDeadlineMs}); job ${jobId} left in retry, probe queued`);

      // A new process picks the job up again and completes it.
      await recreateApp({ PA_CTEST_JOB_DELAY_MS: '1000' });
      await waitFor('the interrupted probe to complete after restart', async () => ((await probeStatus(probeId)) === 'completed' ? true : undefined), 90_000);
      note(`interrupted probe ${probeId} completed after restart`);
      await recreateApp();
    });

    it('fits the worst-case shutdown inside the stop grace period', async () => {
      await ensureDefaultStack();
      const app = await inspect(await containerId(context, 'app'));
      // Services stop one after another; each may take up to its s6 timeout-down,
      // then s6-overlay waits S6_KILL_GRACETIME before killing what is left.
      const timeouts: Record<string, number> = {};
      for (const service of ['watchdog', 'drain', 'worker', 'web', 'api']) {
        timeouts[service] = Number(await dockerExec(app.Id, ['/bin/cat', `/etc/s6-overlay/s6-rc.d/${service}/timeout-down`]));
        expect(timeouts[service], service).toBeGreaterThan(0);
      }
      const killGrace = Number(app.Config.Env.find((entry) => entry.startsWith('S6_KILL_GRACETIME='))?.split('=')[1]);
      expect(killGrace).toBe(3_000);
      // The worker's own deadlines, from the image: at least 5 s for failing jobs
      // back to the queue before the forced exit, which comes before s6 stops
      // waiting for the worker.
      const { drainDeadlineMs, exitDeadlineMs } = await workerShutdown(app.Id);
      expect(exitDeadlineMs - drainDeadlineMs).toBeGreaterThanOrEqual(5_000);
      expect(timeouts.worker).toBeGreaterThan(exitDeadlineMs);
      const worstCase = Object.values(timeouts).reduce((sum, value) => sum + value, 0) + killGrace;
      expect(app.Config.StopTimeout).toBe(60);
      expect(worstCase).toBeLessThanOrEqual(app.Config.StopTimeout! * 1000 - 5_000);
      note(`worst-case shutdown ${worstCase} ms (${Object.entries(timeouts).map(([service, value]) => `${service} ${value}`).join(', ')}, kill grace ${killGrace}) within the ${app.Config.StopTimeout} s stop grace period; worker drain ${drainDeadlineMs}, forced exit ${exitDeadlineMs}`);
    });
  });

  it('container 7. probes and evidence survive down/up and recreation; init re-runs without resetting data', async () => {
    await ensureDefaultStack();
    const probeId = await submitAndComplete('ctest persistence');
    const marker = `ctest-${Date.now()}`;
    const app = await containerId(context, 'app');
    await dockerExec(app, ['/bin/sh', '-c', `printf %s ${marker} > /var/lib/app/evidence/ctest-marker`]);
    const probes = Number(await psql(context, 'SELECT count(*) FROM pa_app.pilot_probes'));

    for (const step of [['down'], ['up', '-d', '--wait', '--no-build', '--force-recreate']] as const) {
      const started = new Date().toISOString();
      await compose(context, [...step], { timeoutMs: 300_000 });
      if (step[0] === 'down') {
        await compose(context, ['up', '-d', '--wait', '--no-build'], { timeoutMs: 300_000 });
      }
      await waitHealthy(context);
      const initLogs = await logs(await containerId(context, 'init'), started);
      expect(initLogs).toContain('init: database prior_authorization exists; roles and grants reapplied');
      expect(initLogs).toContain('application migrations: 0 applied');
      expect(await probeStatus(probeId)).toBe('completed');
      expect(Number(await psql(context, 'SELECT count(*) FROM pa_app.pilot_probes'))).toBe(probes);
      expect(await dockerExec(await containerId(context, 'app'), ['/bin/cat', '/var/lib/app/evidence/ctest-marker'])).toBe(marker);
      note(`after ${step[0]}${step[0] === 'down' ? ' and up' : ' --force-recreate'}: ${probes} probes and the evidence marker kept, init re-ran as a no-op`);
    }
    const volumes = (await sh('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`])).trim().split('\n').sort();
    expect(volumes).toEqual([`${PROJECT}_db-data`, `${PROJECT}_evidence`]);
  });

  it('container 8. processes are unprivileged, capabilities dropped, no-new-privileges set and the root filesystem read-only', async () => {
    await ensureDefaultStack();
    for (const service of ['app', 'init']) {
      const info = await inspect(await containerId(context, service));
      expect(info.Config.User, service).toBe('10001:10001');
      expect(info.HostConfig.ReadonlyRootfs, service).toBe(true);
      expect(info.HostConfig.CapDrop, service).toEqual(['ALL']);
      expect(info.HostConfig.CapAdd ?? [], service).toEqual([]);
      expect(info.HostConfig.SecurityOpt, service).toContain('no-new-privileges:true');
      expect(info.HostConfig.Privileged, service).toBe(false);
      expect(info.HostConfig.Init ?? false, service).toBe(false);
      expect(info.Mounts.filter((mount) => mount.Source.includes('docker.sock')), service).toEqual([]);
    }

    const app = await containerId(context, 'app');
    const report = await nodeInContainer<{
      processes: { pid: string; uid: string; capEff: string; capBnd: string; noNewPrivs: string; command: string }[];
      pid1: string;
      rootMount: string;
      writable: Record<string, string>;
      rwMounts: string[];
    }>(
      app,
      `import { readdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
      const processes = [];
      for (const pid of readdirSync('/proc').filter((name) => /^\\d+$/.test(name))) {
        try {
          const status = readFileSync('/proc/' + pid + '/status', 'utf8');
          const field = (name) => new RegExp('^' + name + ':\\\\s+(\\\\S+)', 'm').exec(status)?.[1];
          processes.push({ pid, uid: field('Uid'), capEff: field('CapEff'), capBnd: field('CapBnd'), noNewPrivs: field('NoNewPrivs'),
            command: readFileSync('/proc/' + pid + '/cmdline', 'utf8').split('\\0')[0] });
        } catch {}
      }
      const writable = {};
      for (const dir of ['/', '/app', '/etc', '/usr/local/lib/pa', '/var/lib/app', '/run', '/tmp', '/var/lib/app/evidence']) {
        const file = dir.replace(/\\/$/, '') + '/.ctest-write';
        try { writeFileSync(file, 'x'); rmSync(file); writable[dir] = 'writable'; } catch (error) { writable[dir] = error.code; }
      }
      const mounts = readFileSync('/proc/mounts', 'utf8').trim().split('\\n').map((line) => line.split(' '));
      console.log(JSON.stringify({
        processes,
        pid1: readFileSync('/proc/1/cmdline', 'utf8').split('\\0')[0],
        rootMount: mounts.find((mount) => mount[1] === '/')[3],
        writable,
        rwMounts: mounts.filter((mount) => mount[3].split(',').includes('rw')).map((mount) => mount[1]),
      }));`,
    );
    expect(report.processes.length).toBeGreaterThan(5);
    for (const entry of report.processes) {
      expect(entry, entry.command).toMatchObject({ uid: '10001', capEff: '0000000000000000', capBnd: '0000000000000000', noNewPrivs: '1' });
    }
    expect(report.pid1).toMatch(/s6-svscan/);
    expect(report.rootMount.split(',')).toContain('ro');
    expect(Object.keys(report.writable).filter((dir) => report.writable[dir] === 'writable')).toEqual(['/run', '/tmp', '/var/lib/app/evidence']);
    expect(report.writable['/app']).toBe('EROFS');
    const allowed = /^(\/proc(\/.*)?|\/dev|\/dev\/pts|\/dev\/mqueue|\/dev\/shm|\/run|\/tmp|\/var\/lib\/app\/evidence)$/;
    expect(report.rwMounts.filter((mount) => !allowed.test(mount))).toEqual([]);
    note(`${report.processes.length} processes, all uid 10001 with no capabilities; PID 1 ${report.pid1}; writable mounts ${report.rwMounts.join(' ')}`);
  });

  it('container 9. no canary or secret in bundle, pages, image, history, environment, labels or logs; credential matrix holds', async () => {
    await ensureDefaultStack();
    const scanner = new Scanner(context.needles);

    // Browser bundle and served pages.
    const served = await servedFiles();
    for (const [path, content] of served) {
      scanner.text(content, `served ${path}`);
    }
    expect([...served.keys()].some((path) => path.endsWith('.js'))).toBe(true);

    // Final image filesystem and every saved layer, with history, environment and labels.
    const exported = await scanExport(scanner, IMAGE, 'image filesystem');
    const saved = await scanSavedImage(scanner, IMAGE, 'saved image');
    scanner.text(await sh('docker', ['history', '--no-trunc', '--format', '{{json .}}', IMAGE]), 'image history');
    scanner.text(await sh('docker', ['image', 'inspect', IMAGE]), 'image environment and labels');
    for (const service of ['db', 'init', 'app']) {
      const id = await containerId(context, service);
      scanner.text(await sh('docker', ['inspect', id]), `${service} container environment and labels`);
      scanner.text(await logs(id), `${service} logs`);
    }
    expect(scanner.findings).toEqual([]);
    note(`no findings: ${served.size} served files, ${Math.round(exported / 1e6)} MB exported filesystem, ${saved.layers} compressed layers in ${saved.files} saved files, history, inspect and logs`);

    // The scan must catch a canary copied into a throwaway image.
    const violation = await mkdtemp(join(tmpdir(), 'pa-ctest-violation-'));
    try {
      await writeFile(join(violation, 'leaked'), context.needles.get('canary secrets file')!);
      await writeFile(join(violation, 'Dockerfile'), `FROM ${IMAGE}\nCOPY leaked /app/leaked-canary\n`);
      await sh('docker', ['build', '-q', '-t', VIOLATION_IMAGE, violation], { timeoutMs: 300_000 });
      const detector = new Scanner(context.needles);
      await scanSavedImage(detector, VIOLATION_IMAGE, 'violation image');
      await scanExport(detector, VIOLATION_IMAGE, 'violation filesystem');
      expect(detector.findings.map((finding) => finding.label)).toEqual(['canary secrets file', 'canary secrets file']);
      expect(detector.findings.map((finding) => finding.where.split(':')[0])).toEqual(['violation image', 'violation filesystem']);
      note(`copied-canary violation detected in ${detector.findings.map((finding) => finding.where).join(' and ')}`);
    } finally {
      await shResult('docker', ['image', 'rm', '-f', VIOLATION_IMAGE]);
      await rm(violation, { recursive: true, force: true });
    }

    // Credential matrix: container environment and mounted secrets.
    const env = async (service: string) => (await inspect(await containerId(context, service))).Config.Env.map((entry) => entry.split('=')[0]!);
    const credentials = (names: string[]) => names.filter((name) => CREDENTIAL.test(name)).sort();
    const appId = await containerId(context, 'app');
    expect(credentials(await env('app'))).toEqual(['BETTER_AUTH_SECRET_FILE', 'DATABASE_URL_API_FILE', 'DATABASE_URL_WORKER_FILE', 'WORKER_SERVICE_TOKEN_FILE']);
    expect((await dockerExec(appId, ['/bin/ls', '/run/secrets'])).trim().split('\n')).toEqual(['better_auth_secret', 'database_url_api', 'database_url_worker', 'worker_service_token']);
    expect(credentials(await env('init'))).toEqual(['DATABASE_URL_ADMIN_FILE', 'DATABASE_URL_API_FILE', 'DATABASE_URL_MIGRATOR_FILE', 'DATABASE_URL_WORKER_FILE']);
    const dbEnv = await env('db');
    expect(dbEnv).toContain('POSTGRES_PASSWORD_FILE');
    expect(dbEnv).not.toContain('POSTGRES_PASSWORD');
    expect(dbEnv).not.toContain('POSTGRES_HOST_AUTH_METHOD');

    // Per running process: each launcher logs the variable names (never values)
    // that its service process holds when it starts.
    const started = new Map<string, string[]>();
    for (const line of (await logs(appId)).split('\n').filter((entry) => entry.includes('"service":"pa-launch"'))) {
      const entry = JSON.parse(line) as { name: string; variables: string[] };
      started.set(entry.name, entry.variables);
    }
    expect([...started.keys()].sort()).toEqual(['api', 'web', 'worker']);
    expect(credentials(started.get('api')!)).toEqual(['BETTER_AUTH_SECRET_FILE', 'DATABASE_URL_API_FILE', 'WORKER_SERVICE_TOKEN_FILE']);
    expect(credentials(started.get('worker')!)).toEqual(['DATABASE_URL_WORKER_FILE', 'WORKER_SERVICE_TOKEN_FILE']);
    expect(credentials(started.get('web')!)).toEqual([]);

    // The database uses password authentication and refuses a wrong password.
    const hba = await psql(context, "SELECT DISTINCT type || ':' || auth_method FROM pg_hba_file_rules WHERE type LIKE 'host%' ORDER BY 1");
    expect(hba.split('\n').every((rule) => rule.endsWith(':scram-sha-256'))).toBe(true);
    const authentication = await nodeInContainer<Record<string, string>>(
      appId,
      `import { createRequire } from 'node:module';
      import { readFileSync } from 'node:fs';
      const { Client } = createRequire('/app/packages/db/package.json')('pg');
      const attempt = async (url) => {
        const client = new Client({ connectionString: url, connectionTimeoutMillis: 5000 });
        try { await client.connect(); return (await client.query('SELECT current_user AS user')).rows[0].user; }
        catch (error) { return 'error ' + error.code; }
        finally { await client.end().catch(() => {}); }
      };
      const api = new URL(readFileSync('/run/secrets/database_url_api', 'utf8').trim());
      const wrongApi = new URL(api); wrongApi.password = 'wrong-password';
      const wrongAdmin = new URL(api); wrongAdmin.username = 'postgres'; wrongAdmin.password = 'wrong-password'; wrongAdmin.pathname = '/postgres';
      console.log(JSON.stringify({ api: await attempt(api.href), wrongApi: await attempt(wrongApi.href), wrongAdmin: await attempt(wrongAdmin.href) }));`,
    );
    expect(authentication).toEqual({ api: 'pa_api', wrongApi: 'error 28P01', wrongAdmin: 'error 28P01' });

    // The app container refuses to start when given an admin or migrator credential.
    await writeContextFile(context, 'ctest-forbidden.yaml', 'services:\n  app:\n    environment:\n      DATABASE_URL_ADMIN_FILE: /run/secrets/database_url_admin\n');
    const since = nowSeconds() - 1;
    await compose(context, ['up', '-d', '--no-deps', '--no-build', 'app'], { files: ['ctest-forbidden.yaml'] });
    const forbiddenId = await containerId(context, 'app');
    const [died] = await waitFor('the app to refuse the admin credential', async () => {
      const events = await dieEvents(forbiddenId, since);
      return events.length > 0 ? events : undefined;
    }, 60_000);
    expect(died!.exitCode).toBe(1);
    expect(await logs(forbiddenId)).toContain('launch: the app container must not receive DATABASE_URL_ADMIN_FILE; remove them from its environment');
    note('credential matrix held; wrong passwords refused with 28P01; admin credential injection refused with exit 1');
    await recreateApp();
  });

  it('container 10. a lock on a healthy database is a hang, not an outage: the watchdog stops the container', async () => {
    await ensureDefaultStack();
    const app = await inspect(await containerId(context, 'app'));
    const since = nowSeconds() - 1;
    const lock = await lockTable(context, 'pa_app.pilot_probes');
    const lockedAt = Date.now();
    try {
      const failing = await waitFor('database_check_failed readiness', async () => {
        const result = await readiness();
        return result.reasons.includes('database_check_failed') ? result : undefined;
      }, 30_000);
      expect(failing.status).toBe(503);
      expect(failing.reasons).not.toContain('database_unavailable');
      expect((await inspect(await containerId(context, 'db'))).State.Health?.Status).toBe('healthy');
      const [died] = await waitFor('the watchdog to stop the container', async () => {
        const events = await dieEvents(app.Id, since);
        return events.length > 0 ? events : undefined;
      }, 120_000);
      const elapsed = died!.time - lockedAt / 1000;
      expect(died!.exitCode).toBe(124);
      expect(elapsed).toBeLessThan(75);
      const output = await logs(app.Id, new Date(lockedAt).toISOString());
      expect(output).toMatch(/watchdog: readiness failed for \d+ s \(database_check_failed\)/);
      expect(output).not.toContain('paused for database outage');
      note(`lock on pa_app.pilot_probes: readiness ${failing.reasons.join(',')} with db healthy; watchdog stopped the container with 124 after ${elapsed.toFixed(1)} s (bound 75 s)`);
    } finally {
      await lock.release();
    }
    const recovered = await waitHealthy(context);
    expect(recovered.RestartCount).toBe(app.RestartCount + 1);
  });

  it('container 11. a startup that never becomes ready stops the container nonzero; a failure during startup keeps its own code', async () => {
    await ensureDefaultStack();
    // Both the API's startup and its queue schema check read pgboss.version.
    const lock = await lockTable(context, 'pgboss.version');
    try {
      const since = nowSeconds() - 1;
      await compose(context, ['up', '-d', '--no-deps', '--no-build', '--force-recreate', 'app']);
      const id = await containerId(context, 'app');
      const first = await inspect(id);
      const startedAt = Date.parse(first.State.StartedAt) / 1000;
      const [timedOut] = await waitFor('the startup bound to stop the container', async () => {
        const events = await dieEvents(id, since);
        return events.length > 0 ? events : undefined;
      }, 200_000, 2_000);
      const elapsed = timedOut!.time - startedAt;
      expect(elapsed).toBeGreaterThanOrEqual(120);
      expect(elapsed).toBeLessThan(140);
      const output = await logs(id);
      // Two s6 timers share the 120-second deadline (docs/operations.md). When
      // s6-rc's own timer fires first it exits 2; when the up-transition's
      // s6-svlisten times out first it exits 99, which s6-rc reports as a failed
      // start and exits 1. Either way, the exit code must match its log line.
      const globalTimeout = output.includes('s6-rc: fatal: timed out');
      const serviceTimeout = /s6-rc: warning: unable to start service (api|worker): command exited 99/.test(output);
      const code = timedOut!.exitCode;
      expect([1, 2]).toContain(code);
      // Exit 2 needs s6-rc's own timeout line (the service line may follow it);
      // exit 1 needs the service line and not s6-rc's.
      expect(globalTimeout, 's6-rc: fatal: timed out').toBe(code === 2);
      expect(code === 2 || serviceTimeout, 'unable to start service ...: command exited 99').toBe(true);
      expect(output).toContain('rc.init: fatal: stopping the container.');
      expect(output).not.toContain('watchdog started');
      expect(first.Config.Env).toContain('S6_CMD_WAIT_FOR_SERVICES_MAXTIME=120000');
      note(`startup blocked by a lock on pgboss.version: container stopped with exit ${timedOut!.exitCode} after ${elapsed.toFixed(1)} s (S6_CMD_WAIT_FOR_SERVICES_MAXTIME 120 s; ${code === 2 ? "s6-rc's own timer" : "the service's s6-svlisten timer"} fired first)`);

      // The restart policy starts it again, still blocked. A service killed
      // during startup also fails s6-rc, which then writes its own exit code;
      // the first failure's code must be the one Docker reports.
      const pid = await waitFor('the API of the restarted container', async () => {
        const info = await inspect(id);
        return info.RestartCount === first.RestartCount + 1 && info.State.Running ? servicePid(id, 'api') : undefined;
      }, 60_000, 500);
      const killSince = Math.ceil(timedOut!.time);
      await dockerExec(id, ['/bin/sh', '-c', `kill -KILL ${pid}`]);
      const [killed] = await waitFor('the API kill to stop the container', async () => {
        const events = await dieEvents(id, killSince);
        return events.length > 0 ? events : undefined;
      }, 60_000);
      expect(killed!.exitCode).toBe(137);
      note(`API killed during a blocked startup: container stopped with ${killed!.exitCode}, not s6-rc's own code`);
    } finally {
      await lock.release();
    }
    await waitHealthy(context);
  });

  it('container 12. the runtime image holds no development dependencies, TypeScript sources, tests or environment files', async () => {
    await ensureDefaultStack();
    const app = await containerId(context, 'app');

    // Development-only packages: every workspace devDependency that no workspace
    // package needs at runtime, plus whole tool families. drizzle-orm depends on
    // @types/pg, which depends on @types/node, so those two are runtime packages.
    const manifests = ['package.json', 'apps/api/package.json', 'apps/web/package.json', 'apps/worker/package.json', 'packages/config/package.json', 'packages/contracts/package.json', 'packages/db/package.json'];
    const runtime = new Set(['@types/node', '@types/pg']);
    const development = new Set<string>();
    for (const manifest of manifests) {
      const parsed = JSON.parse(await readFile(join(context.dir, manifest), 'utf8')) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      Object.keys(parsed.dependencies ?? {}).forEach((name) => runtime.add(name));
      Object.keys(parsed.devDependencies ?? {}).forEach((name) => development.add(name));
    }
    const families = /^(@vitest\/|@typescript-eslint\/|@eslint\/|eslint-|playwright|@playwright\/|@tailwindcss\/|esbuild|@esbuild\/)/;
    const forbidden = (name: string) => !name.startsWith('@pa/') && ((development.has(name) && !runtime.has(name)) || families.test(name));
    expect(forbidden('vitest') && forbidden('typescript') && forbidden('eslint') && forbidden('drizzle-kit') && forbidden('@playwright/test')).toBe(true);

    const stores = ['/app/node_modules/.pnpm', '/app/web/node_modules/.pnpm'];
    const installed = (await dockerExec(app, ['/bin/sh', '-c', `for d in ${stores.join(' ')}; do ls "$d"; done`]))
      .trim()
      .split('\n')
      .map((entry) => entry.replace(/^(@?[^@]+)@.*$/, '$1').replace('+', '/'));
    expect(installed.length).toBeGreaterThan(50);
    expect(installed.filter(forbidden)).toEqual([]);

    // The project's own files: compiled output only, no sources or tests.
    const ownFiles = (await dockerExec(app, ['/bin/sh', '-c', 'for d in /app/apps /app/packages /app/web/apps /app/web/packages; do [ -d "$d" ] && find "$d" -path "*/node_modules" -prune -o -type f -print; done; true']))
      .trim()
      .split('\n');
    expect(ownFiles.length).toBeGreaterThan(20);
    expect(ownFiles.filter((path) => /\.(ts|tsx|mts|cts)$/.test(path) && !/\.d\.(ts|mts|cts)$/.test(path))).toEqual([]);
    expect(ownFiles.filter((path) => /\.(test|spec)\.[^/]+$/.test(path) || /\/(test|tests|__tests__)\//.test(path))).toEqual([]);

    // No environment or secrets file anywhere on the image filesystem.
    expect((await dockerExec(app, ['/bin/sh', '-c', 'find / -xdev \\( -name ".env*" -o -name ".secrets" \\) -print 2>/dev/null; true'])).trim()).toBe('');
    note(`image contents: ${installed.length} installed packages with no development-only package; ${ownFiles.length} project files with no TypeScript source or test; no .env or .secrets`);
  });

  it('container 14. the optional live overlay gives the API alone the ledger and the worker alone the key path, and survives a graceful restart', async () => {
    // Synthetic accounting history and a fake key, outside the build context. No
    // model request is possible: no live run is started.
    const accounting = await mkdtemp(join(tmpdir(), 'pa-ctest-accounting-'));
    const keyDir = await mkdtemp(join(tmpdir(), 'pa-ctest-key-'));
    try {
      await chmod(accounting, 0o777);
      const history = JSON.stringify({
        schemaVersion: 'pa.anthropic-spend.v1', committedUsd: 0.0204,
        entries: [{ reservationId: randomUUID(), runId: 'ctest', day: '2026-10-21', createdAt: '2026-10-21T10:00:00.000Z', model: 'claude-opus-5-5', reservedUsd: 5.16384, actualUsd: 0.0204, usage: { inputTokens: 1100, outputTokens: 800, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 }, status: 'reconciled' }],
      });
      await writeFile(join(accounting, 'ledger.json'), history, { mode: 0o666 });
      await writeFile(join(accounting, 'retained.json'), history, { mode: 0o444 });
      const fakeKey = `PA-CANARY-KEY-${randomUUID()}`;
      context.needles.set('canary live key file', fakeKey);
      await writeFile(join(keyDir, 'anthropic_api_key'), fakeKey, { mode: 0o644 });
      const live = { files: ['compose.live.yaml'], env: { AGENT_RUN_BUDGET_USD: '6', AGENT_DAILY_BUDGET_USD: '20', AGENT_TOTAL_BUDGET_USD: '20', PA_ACCOUNTING_DIR: accounting, PA_ANTHROPIC_API_KEY_HOST_FILE: join(keyDir, 'anthropic_api_key') } };

      // The maintenance command migrates the retained history at the path the API will open.
      const migrated = await composeResult(context, ['run', '--rm', '--no-deps', '--entrypoint', '/usr/local/bin/node', 'app', '/app/apps/api/dist/accounting/cli.js', 'migrate', '--ledger', '/var/lib/pa-accounting/ledger.json', '--source-copy', '/var/lib/pa-accounting/retained.json'], live);
      expect(migrated.code, migrated.stderr).toBe(0);
      expect(JSON.parse(await readFile(join(accounting, 'ledger.json'), 'utf8'))).toMatchObject({ schemaVersion: 'pa.accounting-ledger.v2', account: { ledgerPath: '/var/lib/pa-accounting/ledger.json' } });

      const since = new Date().toISOString();
      await compose(context, ['up', '-d', '--wait', '--no-deps', '--no-build', 'app'], { ...live, timeoutMs: 300_000 });
      await waitHealthy(context);
      let appId = await containerId(context, 'app');
      expect((await http('/api/status')).json).toMatchObject({ modes: { agentGraph: 'live' } });
      await waitFor('live accounting to open', async () => ((await logs(appId, since)).includes('"liveAdmission":"available"') ? true : undefined), 30_000);
      const started = new Map<string, string[]>();
      for (const line of (await logs(appId, since)).split('\n').filter((entry) => entry.includes('"service":"pa-launch"'))) {
        const entry = JSON.parse(line) as { name: string; variables: string[] };
        started.set(entry.name, entry.variables);
      }
      const liveNames = (service: string) => started.get(service)!.filter((name) => /^PA_(ACCOUNTING|ANTHROPIC|EVALUATION)/.test(name)).sort();
      expect(liveNames('api')).toEqual(['PA_ACCOUNTING_LEDGER_FILE']);
      expect(liveNames('worker')).toEqual(['PA_ANTHROPIC_API_KEY_FILE']);
      expect(liveNames('web')).toEqual([]);
      expect(started.get('api')).toContain('AGENT_TOTAL_BUDGET_USD');

      // A graceful recreation releases the account lock, so the next API opens it again.
      const restarted = new Date().toISOString();
      await compose(context, ['up', '-d', '--wait', '--no-deps', '--no-build', '--force-recreate', 'app'], { ...live, timeoutMs: 300_000 });
      await waitHealthy(context);
      appId = await containerId(context, 'app');
      await waitFor('live accounting to reopen', async () => ((await logs(appId, restarted)).includes('"liveAdmission":"available"') ? true : undefined), 30_000);
      const reopened = JSON.parse(await readFile(join(accounting, 'ledger.json'), 'utf8')) as { writerGeneration: number; attempts: unknown[] };
      expect(reopened.writerGeneration).toBe(2);
      expect(reopened.attempts).toHaveLength(1);

      // Without a ledger, live admission stays closed while the app keeps serving.
      await rm(join(accounting, 'ledger.json'));
      const missing = new Date().toISOString();
      await compose(context, ['up', '-d', '--wait', '--no-deps', '--no-build', '--force-recreate', 'app'], { ...live, timeoutMs: 300_000 });
      await waitHealthy(context);
      appId = await containerId(context, 'app');
      await waitFor('live accounting to report missing', async () => ((await logs(appId, missing)).includes('"liveAdmission":"missing"') ? true : undefined), 30_000);
      expect((await readiness()).status).toBe(200);
      note(`live overlay: ledger migrated in container, API/worker paths split, lock reacquired after graceful restart (generation ${reopened.writerGeneration}), missing ledger closes admission`);
    } finally {
      await recreateApp();
      await rm(accounting, { recursive: true, force: true });
      await rm(keyDir, { recursive: true, force: true });
    }
  });

  it('container 13. no secret in the build output or in the output of any container the run created, including replaced ones', async () => {
    await keepContainerLogs(context);
    const scanner = new Scanner(context.needles);
    expect(context.buildOutput.length).toBeGreaterThan(0);
    scanner.text(context.buildOutput, 'image build output');
    for (const [id, output] of context.containerLogs) {
      scanner.text(output, `container ${id.slice(0, 12)} logs`);
    }
    expect(scanner.findings).toEqual([]);
    note(`no findings in ${Math.round(context.buildOutput.length / 1000)} kB of build output and the logs of ${context.containerLogs.size} containers`);
  });
});
