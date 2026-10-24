import { AgentConfigError, loadAgentSettings, type AgentSettings } from '@pa/agents/config';
import { ConfigError, loadApiConfig, type ApiConfig } from '@pa/config';
import { API_HOST, API_PORT } from '@pa/config/topology';
import { createDatabase, createRuntimeBoss, startRuntimeBoss } from '@pa/db';

import { LiveAdmission } from './accounting/service.js';
import { stopInterruptedLiveRuns } from './agent/service.js';
import { buildApi } from './app.js';
import { seedDemoCases } from './cases/seed.js';
import { Health } from './health.js';

// Bound for closing connections once the API is told to stop; the worker has
// already drained by then (see docs/operations.md, shutdown order). Below the
// API's 8-second s6 timeout-down.
const CLOSE_TIMEOUT_MS = 7_000;

let config: ApiConfig;
let agent: AgentSettings;
try {
  config = loadApiConfig();
  agent = loadAgentSettings();
} catch (error) {
  console.error(error instanceof ConfigError || error instanceof AgentConfigError ? error.message : String(error));
  process.exit(1);
}

// Live mode alone opens the canonical ledger and takes the account writer lock.
// Any accounting problem leaves live admission closed while the app still serves.
const admission = await LiveAdmission.start(agent, config.accountingLedgerFile, config.buildRevision);

let poolErrorLog: (error: Error) => void = () => undefined;
const database = createDatabase(config.databaseUrl, 'pa-api', 5, (error) => poolErrorLog(error));
const boss = createRuntimeBoss(config.databaseUrl, 'api');
const health = new Health(database.db);
const app = buildApi({ config, db: database.db, boss, health, agent, admission });
poolErrorLog = (error) => app.log.warn({ err: { message: error.message } }, 'idle database connection failed');
boss.on('error', (error) => app.log.error({ err: { message: error.message } }, 'queue error'));

try {
  await startRuntimeBoss(boss);
  await health.captureSchemaVersion();
  if (admission.live) {
    app.log.info({ liveAdmission: admission.reason ?? 'available' }, 'live accounting state');
    const stopped = await stopInterruptedLiveRuns(database.db, admission);
    if (stopped > 0) app.log.warn({ runs: stopped }, 'interrupted live runs stopped before review');
  }
  // Fixture data mode is the only mode this build accepts: populate the demo
  // queue from the packaged synthetic fixtures. Existing cases are untouched.
  const seeded = await seedDemoCases(database.db, boss);
  app.log.info({ cases: seeded.length, created: seeded.filter((item) => item.created).length }, 'synthetic demo cases seeded');
  await app.listen({ host: API_HOST, port: API_PORT });
} catch (error) {
  app.log.fatal({ err: error }, 'API startup failed');
  await admission.close().catch(() => undefined);
  await database.close().catch(() => undefined);
  process.exit(1);
}

// SIGUSR2 starts draining: readiness reports `shutting_down` and new probe
// submissions get 503, while the internal worker routes stay open so an
// in-flight job can still report its result. The container sends it before
// stopping the worker.
process.on('SIGUSR2', () => {
  if (!health.draining) {
    health.startDraining();
    app.log.info('API draining: readiness false, new submissions refused');
  }
});

let stopping = false;
async function stop(signal: string): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  health.startDraining();
  app.log.info({ signal }, 'API stopping');
  const deadline = setTimeout(() => {
    app.log.error('API did not close in time');
    process.exit(1);
  }, CLOSE_TIMEOUT_MS);
  deadline.unref();
  await app.close();
  await boss.stop({ graceful: false, close: true });
  await database.close();
  // A graceful stop releases the account writer lock, which proves this writer stopped.
  await admission.close();
  app.log.info('API stopped');
}
process.once('SIGTERM', () => void stop('SIGTERM'));
process.once('SIGINT', () => void stop('SIGINT'));
