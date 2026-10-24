import { AgentConfigError, createCheckpointer, loadAgentSettings, sdkLiveClient, type AgentSettings } from '@pa/agents';
import { ConfigError, loadWorkerConfig, type WorkerConfig } from '@pa/config';
import { CHECKPOINT_SCHEMA, createDatabase, createRuntimeBoss, startRuntimeBoss } from '@pa/db';

import { DRAIN_DEADLINE_MS, EXIT_DEADLINE_MS } from './shutdown.js';
import { startWorker, type RunningWorker } from './worker.js';

function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, time: new Date().toISOString(), service: 'pa-worker', message, ...fields });
  (level === 'info' ? console.log : console.error)(line);
}

let config: WorkerConfig;
let agentSettings: AgentSettings;
try {
  config = loadWorkerConfig();
  agentSettings = loadAgentSettings();
} catch (error) {
  console.error(error instanceof ConfigError || error instanceof AgentConfigError ? error.message : String(error));
  process.exit(1);
}

const database = createDatabase(config.databaseUrl, 'pa-worker', 2, (error) => log('warn', 'idle database connection failed', { error: error.message }));
const boss = createRuntimeBoss(config.databaseUrl, 'worker');
// Checkpoints are opened only when recorded or live runs are enabled; rules mode needs none.
const checkpoints = agentSettings.graphProvider === 'off' ? undefined : createCheckpointer(config.databaseUrl, CHECKPOINT_SCHEMA);
// Live mode only: the key file is opened when a live investigation starts, never at startup.
const liveClientFactory = agentSettings.graphProvider === 'live' && config.anthropicApiKeyFile !== null ? sdkLiveClient(config.anthropicApiKeyFile) : undefined;

// pg-boss reports each failed poll; during a database outage that is once per
// second, so repeats of the same message are logged at most every 30 seconds.
const QUEUE_ERROR_REPEAT_MS = 30_000;
let lastQueueError = { message: '', at: 0 };
boss.on('error', (error) => {
  const now = Date.now();
  if (error.message !== lastQueueError.message || now - lastQueueError.at >= QUEUE_ERROR_REPEAT_MS) {
    lastQueueError = { message: error.message, at: now };
    log('error', 'queue error', { error: error.message });
  }
});

let worker: RunningWorker | undefined;
try {
  await startRuntimeBoss(boss);
  worker = await startWorker({
    config, db: database.db, boss, log: (message, fields) => log('info', message, fields),
    agent: checkpoints === undefined ? undefined : { settings: agentSettings, checkpointer: checkpoints.saver, liveClientFactory },
  });
  log('info', 'worker started', { workerId: worker.workerId, bootId: worker.bootId, agentGraph: agentSettings.graphProvider, testJobDelayMs: config.testJobDelayMs || undefined });
} catch (error) {
  log('error', 'worker startup failed', { error: (error as Error).message });
  await database.close().catch(() => undefined);
  await checkpoints?.close().catch(() => undefined);
  process.exit(1);
}

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping || worker === undefined) {
    return;
  }
  stopping = true;
  const startedAt = Date.now();
  // Logged exactly as used; container test group 6 compares them with the
  // compiled constants.
  const drainDeadlineMs = DRAIN_DEADLINE_MS;
  const exitDeadlineMs = EXIT_DEADLINE_MS;
  log('info', 'worker stopping: no new jobs will be claimed', { signal, drainDeadlineMs, exitDeadlineMs });
  setTimeout(() => {
    log('error', 'worker did not exit after its drain deadline');
    process.exit(1);
  }, exitDeadlineMs).unref();

  const result = await worker.drain(drainDeadlineMs);
  if (result.drained) {
    log('info', 'worker drained', { elapsedMs: Date.now() - startedAt });
  } else {
    log('warn', 'drain deadline passed; active jobs returned to the queue for retry', {
      elapsedMs: Date.now() - startedAt,
      jobIds: result.interruptedJobIds,
    });
  }
  await database.close();
  await checkpoints?.close();
  log('info', 'worker stopped', { elapsedMs: Date.now() - startedAt });
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
