// Bounded hang watchdog. Docker only marks an unhealthy container; it does not
// restart it. This service polls readiness through the web server and stops the
// container (exit code 124) when readiness stays failed, so the restart policy
// recovers the whole unit. It holds no credentials.
//
// Bounds (docs/operations.md): readiness is polled every 5 s. The watchdog arms
// on the first ready answer, or 120 s after it starts. Once armed, readiness
// failing for 30 s stops the container. The clock pauses only for a confirmed
// database outage: readiness reports a database reason and the watchdog itself
// cannot open a TCP connection to the database (the host and port the API
// connects to, which its launcher writes to /run/pa/database-address; without
// that file the clock never pauses). Restarting cannot fix an outage, and the
// services recover when the database returns. A database that accepts
// connections but cannot answer the check (a lock wait, an exhausted pool, a
// timeout) is a hang like any other. A stalled worker misses heartbeats for 15 s
// before readiness fails, so the container stops within about 50 s of the
// worker's last heartbeat. Startup before the watchdog runs is bounded by
// S6_CMD_WAIT_FOR_SERVICES_MAXTIME instead.
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';

const READY_URL = 'http://127.0.0.1:3105/api/health/ready';
const POLL_MS = 5_000;
const REQUEST_TIMEOUT_MS = 4_000;
const STARTUP_GRACE_MS = 120_000;
const HANG_LIMIT_MS = 30_000;
const HALT_EXIT_CODE = '124';
// The database host and port, written by the API's launcher (launch.mjs) from
// the API's database URL. A TCP connection needs no credential.
const DATABASE_ADDRESS_FILE = '/run/pa/database-address';
const DATABASE_CONNECT_TIMEOUT_MS = 2_000;
const DATABASE_REASONS = ['database_unavailable', 'database_check_failed'];

function log(level, message, fields = {}) {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'pa-watchdog', message, ...fields });
  (level === 'info' ? console.log : console.error)(line);
}

/** `{ host, port }` from the launcher's file, or undefined when it is missing or invalid. */
function readDatabaseAddress() {
  try {
    const match = /^(.+):(\d{1,5})$/.exec(readFileSync(DATABASE_ADDRESS_FILE, 'utf8').trim());
    return match === null ? undefined : { host: match[1], port: Number(match[2]) };
  } catch {
    return undefined;
  }
}

const databaseAddress = readDatabaseAddress();

/** Resolves to undefined when the database accepts a TCP connection, or to the failure. */
function databaseConnectFailure() {
  return new Promise((resolve) => {
    const socket = connect(databaseAddress);
    const finish = (failure) => {
      socket.destroy();
      resolve(failure);
    };
    socket.setTimeout(DATABASE_CONNECT_TIMEOUT_MS, () => finish('connect timeout'));
    socket.once('connect', () => finish(undefined));
    socket.once('error', (error) => finish(error.code ?? error.message));
  });
}

/** One readiness probe: ready, a confirmed database outage, or a failure with a reason. */
async function probe() {
  try {
    const response = await fetch(READY_URL, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await response.json().catch(() => undefined);
    const reasons = Array.isArray(body?.reasons) ? body.reasons.filter((reason) => typeof reason === 'string') : [];
    if (response.status === 200 && body?.ready === true) {
      return { state: 'ready' };
    }
    const reason = reasons.length > 0 ? reasons.join(',') : `http_${response.status}`;
    if (databaseAddress !== undefined && reasons.some((entry) => DATABASE_REASONS.includes(entry))) {
      const failure = await databaseConnectFailure();
      if (failure !== undefined) {
        return { state: 'outage', reasons, database: `${databaseAddress.host}:${databaseAddress.port} ${failure}` };
      }
    }
    return { state: 'failing', reason };
  } catch (error) {
    return { state: 'failing', reason: error instanceof Error && error.name === 'TimeoutError' ? 'readiness_timeout' : 'web_unreachable' };
  }
}

const startedAt = Date.now();
let armed = false;
let failingSince;
let lastReported;
let halting = false;

function report(state, fields = {}) {
  if (state !== lastReported) {
    lastReported = state;
    log(state === 'ready' ? 'info' : 'warn', `readiness ${state}`, fields);
  }
}

async function tick() {
  const result = await probe();
  if (halting) {
    return;
  }
  const now = Date.now();
  if (result.state === 'ready') {
    armed = true;
    failingSince = undefined;
    report('ready');
    return;
  }
  if (result.state === 'outage') {
    failingSince = undefined;
    report('paused for database outage', { reasons: result.reasons, database: result.database });
    return;
  }
  if (!armed && now - startedAt < STARTUP_GRACE_MS) {
    return;
  }
  armed = true;
  failingSince ??= now;
  report('failing', { reason: result.reason });
  if (now - failingSince >= HANG_LIMIT_MS) {
    halting = true;
    const reason = `watchdog: readiness failed for ${Math.round((now - failingSince) / 1000)} s (${result.reason})`;
    log('error', reason);
    spawn('/usr/local/lib/pa/pa-halt', [HALT_EXIT_CODE, reason], { stdio: 'inherit' }).on('error', (error) => {
      log('error', 'watchdog could not stop the container', { error: error.message });
    });
  }
}

// Intentional shutdown stops the watchdog first, so it never reports the drain as a hang.
process.once('SIGTERM', () => process.exit(0));
process.once('SIGINT', () => process.exit(0));

log('info', 'watchdog started', {
  pollMs: POLL_MS,
  startupGraceMs: STARTUP_GRACE_MS,
  hangLimitMs: HANG_LIMIT_MS,
  databaseAddress: databaseAddress === undefined ? 'unknown; no outage pause' : `${databaseAddress.host}:${databaseAddress.port}`,
});
for (;;) {
  await tick();
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
