import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export type Env = Readonly<Record<string, string | undefined>>;
export type ReadSecretFile = (path: string) => string;

export const APP_ID = 'prior-authorization';

export type DataMode = 'fixture';
export type AgentMode = 'rules';
export type AuthMode = 'fixture';
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

const LOG_LEVELS: readonly LogLevel[] = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'];

// Values the blueprint defines for each mode, and the subset this build supports.
// A known but unsupported value fails startup instead of degrading to a default.
const MODES = {
  DATA_MODE: { known: ['fixture', 'sandbox', 'live'], supported: ['fixture'], fallback: 'fixture' },
  AGENT_MODE: { known: ['rules', 'claude'], supported: ['rules'], fallback: 'rules' },
  AUTH_MODE: { known: ['fixture', 'session'], supported: ['fixture'], fallback: 'fixture' },
} as const;

type ModeName = keyof typeof MODES;

const MIN_SERVICE_TOKEN_LENGTH = 32;
const MAX_WORKER_CONCURRENCY = 16;
const MAX_TEST_JOB_DELAY_MS = 120_000;
const BUILD_REVISION = /^[0-9A-Za-z._-]{1,64}$/;
export const DEFAULT_PUBLIC_ORIGIN = 'http://127.0.0.1:3105';

/**
 * Configuration failure. Messages name variables and never include their values,
 * so the error is safe to log even when a secret was misplaced.
 */
export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

export interface CoreConfig {
  appId: typeof APP_ID;
  dataMode: DataMode;
  agentMode: AgentMode;
  authMode: AuthMode;
  logLevel: LogLevel;
}

export interface ApiConfig extends CoreConfig {
  databaseUrl: string;
  workerServiceToken: string;
  /** Image revision from `PA_BUILD_REVISION`, or `unknown` for a host run. */
  buildRevision: string;
  /** Better Auth signing secret (`BETTER_AUTH_SECRET`). */
  authSecret: string;
  /** The one trusted browser origin (`PA_PUBLIC_ORIGIN`), loopback 3105 by default. */
  publicOrigin: string;
  /**
   * Canonical accounting ledger (`PA_ACCOUNTING_LEDGER_FILE`), read only in
   * live agent mode. It must live outside the database volume and every
   * backup, restore and reset path. Null when unset.
   */
  accountingLedgerFile: string | null;
  /** Bearer token for the evaluation admission routes; null leaves them closed. */
  evaluationAdmissionToken: string | null;
}

export interface WorkerConfig extends CoreConfig {
  databaseUrl: string;
  workerServiceToken: string;
  concurrency: number;
  /** Test-only delay inside each pilot job (`PILOT_TEST_JOB_DELAY_MS`); 0 outside container tests. */
  testJobDelayMs: number;
  /** Anthropic key file path (`PA_ANTHROPIC_API_KEY_FILE`), opened only for a live run. Never read at startup. */
  anthropicApiKeyFile: string | null;
}

export interface MigratorConfig {
  appId: typeof APP_ID;
  logLevel: LogLevel;
  databaseUrl: string;
}

const readUtf8: ReadSecretFile = (path) => readFileSync(path, 'utf8');

class Reader {
  readonly problems: string[] = [];

  constructor(
    private readonly env: Env,
    private readonly readFile: ReadSecretFile,
  ) {}

  /** Unset and empty values are treated alike, so a blank `.env` entry never conflicts. */
  private value(name: string): string | undefined {
    const raw = this.env[name];
    return raw === undefined || raw === '' ? undefined : raw;
  }

  appId(): typeof APP_ID {
    const value = this.value('APP_ID');
    if (value === undefined) {
      this.problems.push('APP_ID is required');
    } else if (value !== APP_ID) {
      this.problems.push(`APP_ID must be ${APP_ID}`);
    }
    return APP_ID;
  }

  mode<N extends ModeName>(name: N): (typeof MODES)[N]['supported'][number] {
    const spec = MODES[name];
    const value = this.value(name);
    if (value === undefined) {
      return spec.fallback;
    }
    const supported: readonly string[] = spec.supported;
    if (supported.includes(value)) {
      return value as (typeof MODES)[N]['supported'][number];
    }
    const known: readonly string[] = spec.known;
    // Only echo recognised mode names; an arbitrary value might be a misplaced secret.
    const shown = known.includes(value) ? `${name}=${value} is not supported by this build` : `${name} has an unrecognised value`;
    this.problems.push(`${shown} (supported: ${supported.join(', ')})`);
    return spec.fallback;
  }

  logLevel(): LogLevel {
    const value = this.value('LOG_LEVEL');
    if (value === undefined) {
      return 'info';
    }
    const level = LOG_LEVELS.find((candidate) => candidate === value);
    if (level === undefined) {
      this.problems.push(`LOG_LEVEL must be one of ${LOG_LEVELS.join(', ')}`);
      return 'info';
    }
    return level;
  }

  integer(name: string, fallback: number, min: number, max: number): number {
    const value = this.value(name);
    if (value === undefined) {
      return fallback;
    }
    const parsed = /^\d+$/.test(value) ? Number(value) : Number.NaN;
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
      this.problems.push(`${name} must be an integer from ${min} to ${max}`);
      return fallback;
    }
    return parsed;
  }

  buildRevision(): string {
    const value = this.value('PA_BUILD_REVISION');
    if (value === undefined) {
      return 'unknown';
    }
    if (!BUILD_REVISION.test(value)) {
      this.problems.push('PA_BUILD_REVISION must be 1-64 characters of A-Z, a-z, 0-9, ., _ or -');
      return 'unknown';
    }
    return value;
  }

  /**
   * A deliberate job delay for shutdown tests. It is refused unless the requested
   * data mode is fixture, judged on the raw value so a rejected mode cannot pass
   * through its fallback.
   */
  testJobDelayMs(): number {
    const delay = this.integer('PILOT_TEST_JOB_DELAY_MS', 0, 0, MAX_TEST_JOB_DELAY_MS);
    if (delay > 0 && (this.value('DATA_MODE') ?? MODES.DATA_MODE.fallback) !== 'fixture') {
      this.problems.push('PILOT_TEST_JOB_DELAY_MS is allowed only with DATA_MODE=fixture');
      return 0;
    }
    return delay;
  }

  /** Reads `NAME` or `NAME_FILE`, rejecting both; file contents lose one trailing newline. */
  secret(name: string): string | undefined {
    const inline = this.value(name);
    const filePath = this.value(`${name}_FILE`);
    if (inline !== undefined && filePath !== undefined) {
      this.problems.push(`${name} and ${name}_FILE are both set; set only one`);
      return undefined;
    }
    if (filePath === undefined) {
      if (inline === undefined) {
        this.problems.push(`${name} or ${name}_FILE is required`);
      }
      return inline;
    }
    let content: string;
    try {
      content = this.readFile(filePath);
    } catch {
      this.problems.push(`${name}_FILE could not be read`);
      return undefined;
    }
    const secret = content.replace(/\r?\n$/, '');
    if (secret === '') {
      this.problems.push(`${name}_FILE names an empty file`);
      return undefined;
    }
    return secret;
  }

  databaseUrl(name: string): string {
    const value = this.secret(name);
    if (value === undefined) {
      return '';
    }
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== 'postgres:' && url.protocol !== 'postgresql:') || url.username === '') {
      this.problems.push(`${name} must be a postgres:// URL with a user name`);
    }
    return value;
  }

  serviceToken(name: string): string {
    const value = this.secret(name);
    if (value === undefined) {
      return '';
    }
    if (value.length < MIN_SERVICE_TOKEN_LENGTH) {
      this.problems.push(`${name} must be at least ${MIN_SERVICE_TOKEN_LENGTH} characters`);
    }
    return value;
  }

  /** An exact http(s) origin with no path, query or credentials. */
  publicOrigin(): string {
    const value = this.value('PA_PUBLIC_ORIGIN');
    if (value === undefined) {
      return DEFAULT_PUBLIC_ORIGIN;
    }
    let url: URL | undefined;
    try {
      url = new URL(value);
    } catch {
      url = undefined;
    }
    if (url === undefined || (url.protocol !== 'http:' && url.protocol !== 'https:') || url.origin !== value) {
      this.problems.push('PA_PUBLIC_ORIGIN must be an exact http(s) origin such as http://127.0.0.1:3105');
      return DEFAULT_PUBLIC_ORIGIN;
    }
    // Fixture sign-in needs no credential, so it is served only to this host.
    // AUTH_MODE=fixture is the only mode this build accepts.
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
      this.problems.push('PA_PUBLIC_ORIGIN must be a loopback origin (127.0.0.1, localhost or [::1]) while AUTH_MODE=fixture');
      return DEFAULT_PUBLIC_ORIGIN;
    }
    return value;
  }

  /** An optional `NAME` or `NAME_FILE` secret with the service-token length rule. */
  optionalToken(name: string): string | null {
    if (this.value(name) === undefined && this.value(`${name}_FILE`) === undefined) {
      return null;
    }
    return this.serviceToken(name);
  }

  /** An optional absolute file path; the file itself is not opened here. */
  optionalPath(name: string): string | null {
    const value = this.value(name);
    if (value === undefined) {
      return null;
    }
    if (!isAbsolute(value)) {
      this.problems.push(`${name} must be an absolute path`);
      return null;
    }
    return value;
  }

  /** Exact variable names a service must never receive. */
  forbidExact(names: readonly string[], service: string): void {
    for (const name of names) {
      if (this.value(name) !== undefined) {
        this.problems.push(`${name} must not be provided to the ${service}`);
      }
    }
  }

  /** A service must not inherit credentials of a more privileged or a different role. */
  forbid(names: readonly string[], service: string): void {
    for (const name of names) {
      if (this.value(name) !== undefined || this.value(`${name}_FILE`) !== undefined) {
        this.problems.push(`${name} must not be provided to the ${service}`);
      }
    }
  }

  core(): CoreConfig {
    return {
      appId: this.appId(),
      dataMode: this.mode('DATA_MODE'),
      agentMode: this.mode('AGENT_MODE'),
      authMode: this.mode('AUTH_MODE'),
      logLevel: this.logLevel(),
    };
  }

  finish<T>(config: T): T {
    if (this.problems.length > 0) {
      throw new ConfigError(this.problems);
    }
    return config;
  }
}

export function loadApiConfig(env: Env = process.env, readFile: ReadSecretFile = readUtf8): ApiConfig {
  const reader = new Reader(env, readFile);
  reader.forbid(['DATABASE_URL_ADMIN', 'DATABASE_URL_MIGRATOR', 'DATABASE_URL_WORKER'], 'API');
  // The provider key belongs to the worker alone.
  reader.forbid(['ANTHROPIC_API_KEY', 'PA_ANTHROPIC_API_KEY'], 'API');
  // The retired JSON ledger is migration input only, never a second account.
  reader.forbidExact(['PA_ANTHROPIC_LEDGER_FILE'], 'API');
  return reader.finish({
    ...reader.core(),
    databaseUrl: reader.databaseUrl('DATABASE_URL_API'),
    workerServiceToken: reader.serviceToken('WORKER_SERVICE_TOKEN'),
    buildRevision: reader.buildRevision(),
    authSecret: reader.serviceToken('BETTER_AUTH_SECRET'),
    publicOrigin: reader.publicOrigin(),
    accountingLedgerFile: reader.optionalPath('PA_ACCOUNTING_LEDGER_FILE'),
    evaluationAdmissionToken: reader.optionalToken('PA_EVALUATION_ADMISSION_TOKEN'),
  });
}

export function loadWorkerConfig(env: Env = process.env, readFile: ReadSecretFile = readUtf8): WorkerConfig {
  const reader = new Reader(env, readFile);
  reader.forbid(['DATABASE_URL_ADMIN', 'DATABASE_URL_MIGRATOR', 'DATABASE_URL_API', 'BETTER_AUTH_SECRET'], 'worker');
  // Accounting is the API's alone; the worker reaches it only through admission routes.
  reader.forbid(['PA_EVALUATION_ADMISSION_TOKEN'], 'worker');
  // The key is read only from PA_ANTHROPIC_API_KEY_FILE, never from an inline variable.
  reader.forbidExact(['PA_ACCOUNTING_LEDGER_FILE', 'PA_ANTHROPIC_LEDGER_FILE', 'ANTHROPIC_API_KEY', 'PA_ANTHROPIC_API_KEY'], 'worker');
  return reader.finish({
    ...reader.core(),
    databaseUrl: reader.databaseUrl('DATABASE_URL_WORKER'),
    workerServiceToken: reader.serviceToken('WORKER_SERVICE_TOKEN'),
    concurrency: reader.integer('WORKER_CONCURRENCY', 2, 1, MAX_WORKER_CONCURRENCY),
    testJobDelayMs: reader.testJobDelayMs(),
    anthropicApiKeyFile: reader.optionalPath('PA_ANTHROPIC_API_KEY_FILE'),
  });
}

export interface ProvisionConfig {
  adminDatabaseUrl: string;
  migratorDatabaseUrl: string;
  apiDatabaseUrl: string;
  workerDatabaseUrl: string;
}

/** One-off database/role provisioning; role passwords come from the three role URLs. */
export function loadProvisionConfig(env: Env = process.env, readFile: ReadSecretFile = readUtf8): ProvisionConfig {
  const reader = new Reader(env, readFile);
  return reader.finish({
    adminDatabaseUrl: reader.databaseUrl('DATABASE_URL_ADMIN'),
    migratorDatabaseUrl: reader.databaseUrl('DATABASE_URL_MIGRATOR'),
    apiDatabaseUrl: reader.databaseUrl('DATABASE_URL_API'),
    workerDatabaseUrl: reader.databaseUrl('DATABASE_URL_WORKER'),
  });
}

export function loadMigratorConfig(env: Env = process.env, readFile: ReadSecretFile = readUtf8): MigratorConfig {
  const reader = new Reader(env, readFile);
  return reader.finish({
    appId: reader.appId(),
    logLevel: reader.logLevel(),
    databaseUrl: reader.databaseUrl('DATABASE_URL_MIGRATOR'),
  });
}
