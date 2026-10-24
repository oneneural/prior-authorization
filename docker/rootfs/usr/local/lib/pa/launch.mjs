// Starts one application service inside this Node process with only the
// environment that service needs (usage: launch.mjs api|worker|web). Before the
// service starts it logs the names of the variables it now holds, never their
// values; the container tests read that line to check the credential matrix of
// each running process.
//
// s6-overlay starts services with an empty environment and keeps the container
// environment as one file per variable in /run/s6/container_environment. This
// launcher copies an allowlist from there, then imports the service entry point
// in the same process, so s6 supervises the service itself and no wrapper can
// hide its exit status.
import { closeSync, mkdirSync, readdirSync, readFileSync, writeFileSync, writeSync } from 'node:fs';

const CONTAINER_ENV = '/run/s6/container_environment';

// The API launcher writes the database host and port (no credential) here for
// the watchdog, which holds no credential itself (watchdog.mjs).
const DATABASE_ADDRESS_FILE = '/run/pa/database-address';

// s6 opens this descriptor for services with a notification-fd file; writing a
// newline marks the service ready so dependants start only afterwards.
const NOTIFICATION_FD = 3;

const CORE = ['APP_ID', 'DATA_MODE', 'AGENT_MODE', 'AUTH_MODE', 'LOG_LEVEL', 'NODE_ENV', 'TZ'];
const withFile = (names) => names.flatMap((name) => [name, `${name}_FILE`]);
// Investigation settings (packages/agents/src/config.ts). Inline provider keys
// and external tracing variables are never copied, so they cannot reach a
// service. In live mode the API alone gets the accounting ledger path and the
// worker alone gets the key file path.
const AGENT = ['AGENT_GRAPH_PROVIDER', 'AGENT_RUN_BUDGET_USD', 'AGENT_DAILY_BUDGET_USD', 'AGENT_TOTAL_BUDGET_USD', 'AGENT_MAX_TOOL_CALLS', 'AGENT_MAX_MODEL_CALLS', 'AGENT_MAX_RUN_SECONDS'];

const SERVICES = {
  api: {
    entry: '/app/apps/api/dist/main.js',
    notify: true,
    allow: [...CORE, ...AGENT, ...withFile(['DATABASE_URL_API', 'WORKER_SERVICE_TOKEN', 'BETTER_AUTH_SECRET', 'PA_EVALUATION_ADMISSION_TOKEN']), 'PA_BUILD_REVISION', 'PA_PUBLIC_ORIGIN', 'PA_ACCOUNTING_LEDGER_FILE'],
  },
  worker: {
    entry: '/app/apps/worker/dist/main.js',
    notify: true,
    allow: [...CORE, ...AGENT, ...withFile(['DATABASE_URL_WORKER', 'WORKER_SERVICE_TOKEN']), 'WORKER_CONCURRENCY', 'PILOT_TEST_JOB_DELAY_MS', 'PA_ANTHROPIC_API_KEY_FILE'],
  },
  // The web server holds no database credential, worker token or session secret.
  web: {
    entry: '/app/web/apps/web/server.js',
    notify: false,
    allow: ['NODE_ENV', 'TZ', 'NEXT_TELEMETRY_DISABLED', 'PA_PUBLIC_ORIGIN'],
    fixed: { HOSTNAME: '0.0.0.0', PORT: '3105' },
  },
};

// Provisioning and migration credentials belong to the one-off init container.
// The app container refuses to start if they reach it at all.
const FORBIDDEN = withFile(['DATABASE_URL_ADMIN', 'DATABASE_URL_MIGRATOR', 'POSTGRES_PASSWORD']);

const [name] = process.argv.slice(2);
const service = Object.hasOwn(SERVICES, name ?? '') ? SERVICES[name] : undefined;
if (service === undefined) {
  console.error(`launch: unknown service ${JSON.stringify(name)}`);
  process.exit(2);
}

const available = new Set(readdirSync(CONTAINER_ENV));
const present = FORBIDDEN.filter((variable) => available.has(variable));
if (present.length > 0) {
  // Names only, never values.
  console.error(`launch: the app container must not receive ${present.join(', ')}; remove them from its environment`);
  process.exit(1);
}

for (const key of Object.keys(process.env)) {
  if (key !== 'PATH') {
    delete process.env[key];
  }
}
for (const variable of service.allow) {
  if (available.has(variable)) {
    // Each file holds the value followed by one newline.
    process.env[variable] = readFileSync(`${CONTAINER_ENV}/${variable}`, 'utf8').replace(/\n$/, '');
  }
}
Object.assign(process.env, service.fixed ?? {});

/** `host:port` of a PostgreSQL URL, or undefined when it names no TCP host. */
function databaseAddress(url) {
  try {
    const { hostname, port } = new URL(url);
    return hostname === '' ? undefined : `${hostname.replace(/^\[(.*)\]$/, '$1')}:${port || '5432'}`;
  } catch {
    return undefined;
  }
}

if (name === 'api') {
  const file = process.env.DATABASE_URL_API_FILE;
  let url = process.env.DATABASE_URL_API;
  try {
    url ??= file === undefined ? undefined : readFileSync(file, 'utf8').replace(/\n$/, '');
  } catch {
    // The API's configuration reports an unreadable file by name.
  }
  const address = url === undefined ? undefined : databaseAddress(url);
  // Without the file the watchdog never pauses for an outage, so a database it
  // cannot locate counts as a hang (fails closed).
  if (address !== undefined) {
    mkdirSync('/run/pa', { recursive: true });
    writeFileSync(DATABASE_ADDRESS_FILE, `${address}\n`);
  }
}

console.log(
  JSON.stringify({ level: 'info', time: new Date().toISOString(), service: 'pa-launch', message: 'starting service', name, variables: Object.keys(process.env).sort() }),
);

// Resolves after the entry module's top-level await: the API is listening, or
// the worker has started consuming.
await import(service.entry);

if (service.notify) {
  writeSync(NOTIFICATION_FD, '\n');
  closeSync(NOTIFICATION_FD);
}
