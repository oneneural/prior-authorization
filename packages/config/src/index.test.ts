import { describe, expect, it } from 'vitest';

import { ConfigError, loadApiConfig, loadMigratorConfig, loadWorkerConfig, type Env } from './index.js';

const API_URL = 'postgres://pa_api:api-secret-value@127.0.0.1:35105/prior_authorization';
const WORKER_URL = 'postgres://pa_worker:worker-secret-value@127.0.0.1:35105/prior_authorization';
const ADMIN_URL = 'postgres://postgres:admin-secret-value@127.0.0.1:35105/postgres';
const TOKEN = 'service-token-secret-value-0123456789abcdef';

const AUTH_SECRET = 'better-auth-secret-value-0123456789abcdef';

const apiEnv: Env = {
  APP_ID: 'prior-authorization',
  DATABASE_URL_API: API_URL,
  WORKER_SERVICE_TOKEN: TOKEN,
  BETTER_AUTH_SECRET: AUTH_SECRET,
};

const workerEnv: Env = {
  APP_ID: 'prior-authorization',
  DATABASE_URL_WORKER: WORKER_URL,
  WORKER_SERVICE_TOKEN: TOKEN,
};

function problemsOf(load: () => unknown): readonly string[] {
  try {
    load();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error('expected configuration to be rejected');
}

function messageOf(load: () => unknown): string {
  try {
    load();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected configuration to be rejected');
}

const noFiles = (): string => {
  throw new Error('unexpected file read');
};

describe('runtime configuration', () => {
  it('applies the initial fixture, rules and fixture-auth defaults', () => {
    expect(loadApiConfig(apiEnv, noFiles)).toEqual({
      appId: 'prior-authorization',
      dataMode: 'fixture',
      agentMode: 'rules',
      authMode: 'fixture',
      logLevel: 'info',
      databaseUrl: API_URL,
      workerServiceToken: TOKEN,
      buildRevision: 'unknown',
      authSecret: AUTH_SECRET,
      publicOrigin: 'http://127.0.0.1:3105',
      accountingLedgerFile: null,
      evaluationAdmissionToken: null,
    });
    expect(loadWorkerConfig(workerEnv, noFiles)).toMatchObject({ concurrency: 2, testJobDelayMs: 0, anthropicApiKeyFile: null });
  });

  it('gives the ledger and evaluation token to the API alone and the key file to the worker alone, without reading the key', () => {
    const api = loadApiConfig({ ...apiEnv, PA_ACCOUNTING_LEDGER_FILE: '/var/lib/pa-accounting/ledger.json', PA_EVALUATION_ADMISSION_TOKEN_FILE: '/run/secrets/eval' }, () => `${TOKEN}\n`);
    expect(api).toMatchObject({ accountingLedgerFile: '/var/lib/pa-accounting/ledger.json', evaluationAdmissionToken: TOKEN });
    expect(loadWorkerConfig({ ...workerEnv, PA_ANTHROPIC_API_KEY_FILE: '/run/secrets/anthropic_api_key' }, noFiles).anthropicApiKeyFile).toBe('/run/secrets/anthropic_api_key');
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_ACCOUNTING_LEDGER_FILE: 'relative/ledger.json' }, noFiles))).toEqual(['PA_ACCOUNTING_LEDGER_FILE must be an absolute path']);
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_ANTHROPIC_API_KEY_FILE: '/run/secrets/k' }, noFiles))).toEqual(['PA_ANTHROPIC_API_KEY must not be provided to the API']);
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, ANTHROPIC_API_KEY: 'sk-ant-synthetic' }, noFiles))).toEqual(['ANTHROPIC_API_KEY must not be provided to the API']);
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_ANTHROPIC_LEDGER_FILE: '/tmp/old.json' }, noFiles))).toEqual(['PA_ANTHROPIC_LEDGER_FILE must not be provided to the API']);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, PA_ACCOUNTING_LEDGER_FILE: '/var/lib/x.json' }, noFiles))).toEqual(['PA_ACCOUNTING_LEDGER_FILE must not be provided to the worker']);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, PA_EVALUATION_ADMISSION_TOKEN: TOKEN }, noFiles))).toEqual(['PA_EVALUATION_ADMISSION_TOKEN must not be provided to the worker']);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, ANTHROPIC_API_KEY: 'sk-ant-synthetic' }, noFiles))).toEqual(['ANTHROPIC_API_KEY must not be provided to the worker']);
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_EVALUATION_ADMISSION_TOKEN: 'short' }, noFiles))).toEqual(['PA_EVALUATION_ADMISSION_TOKEN must be at least 32 characters']);
  });

  it('reads the trusted public origin exactly and rejects paths or non-http origins', () => {
    expect(loadApiConfig({ ...apiEnv, PA_PUBLIC_ORIGIN: 'http://127.0.0.1:4105' }, noFiles).publicOrigin).toBe('http://127.0.0.1:4105');
    for (const value of ['http://127.0.0.1:3105/', 'ftp://127.0.0.1', 'not a url']) {
      expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_PUBLIC_ORIGIN: value }, noFiles))).toEqual(['PA_PUBLIC_ORIGIN must be an exact http(s) origin such as http://127.0.0.1:3105']);
    }
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, BETTER_AUTH_SECRET: AUTH_SECRET }, noFiles))).toEqual(['BETTER_AUTH_SECRET must not be provided to the worker']);
  });

  it('refuses a non-loopback public origin while fixture sign-in is the auth mode', () => {
    for (const value of ['http://localhost:3105', 'http://[::1]:3105']) {
      expect(loadApiConfig({ ...apiEnv, PA_PUBLIC_ORIGIN: value }, noFiles).publicOrigin).toBe(value);
    }
    for (const value of ['https://pa.example.com', 'http://192.168.1.20:3105', 'http://0.0.0.0:3105']) {
      expect(problemsOf(() => loadApiConfig({ ...apiEnv, PA_PUBLIC_ORIGIN: value }, noFiles))).toEqual([
        'PA_PUBLIC_ORIGIN must be a loopback origin (127.0.0.1, localhost or [::1]) while AUTH_MODE=fixture',
      ]);
    }
  });

  it('accepts an image build revision and rejects a malformed one without echoing it', () => {
    expect(loadApiConfig({ ...apiEnv, PA_BUILD_REVISION: 'a1b2c3d-dirty' }, noFiles).buildRevision).toBe('a1b2c3d-dirty');
    const message = messageOf(() => loadApiConfig({ ...apiEnv, PA_BUILD_REVISION: 'rev with spaces secret' }, noFiles));
    expect(message).toContain('PA_BUILD_REVISION must be 1-64 characters');
    expect(message).not.toContain('rev with spaces secret');
  });

  it('bounds the test-only job delay and refuses it outside fixture mode', () => {
    expect(loadWorkerConfig({ ...workerEnv, PILOT_TEST_JOB_DELAY_MS: '8000' }, noFiles).testJobDelayMs).toBe(8000);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, PILOT_TEST_JOB_DELAY_MS: '120001' }, noFiles))).toEqual([
      'PILOT_TEST_JOB_DELAY_MS must be an integer from 0 to 120000',
    ]);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, DATA_MODE: 'live', PILOT_TEST_JOB_DELAY_MS: '8000' }, noFiles))).toEqual([
      'DATA_MODE=live is not supported by this build (supported: fixture)',
      'PILOT_TEST_JOB_DELAY_MS is allowed only with DATA_MODE=fixture',
    ]);
  });

  it.each([
    ['DATA_MODE', 'live', 'DATA_MODE=live is not supported by this build (supported: fixture)'],
    ['DATA_MODE', 'sandbox', 'DATA_MODE=sandbox is not supported by this build (supported: fixture)'],
    ['AGENT_MODE', 'claude', 'AGENT_MODE=claude is not supported by this build (supported: rules)'],
    ['AUTH_MODE', 'session', 'AUTH_MODE=session is not supported by this build (supported: fixture)'],
  ])('rejects the known but unsupported %s=%s', (name, value, problem) => {
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, [name]: value }, noFiles))).toEqual([problem]);
  });

  it('rejects an unrecognised mode without echoing its value', () => {
    const message = messageOf(() => loadWorkerConfig({ ...apiEnv, DATABASE_URL_WORKER: WORKER_URL, DATA_MODE: 'fixture-ish-secret' }, noFiles));
    expect(message).toContain('DATA_MODE has an unrecognised value (supported: fixture)');
    expect(message).not.toContain('fixture-ish-secret');
  });

  it('reads a secret from its _FILE variant and strips one trailing newline', () => {
    const files: Record<string, string> = { '/run/secrets/token': `${TOKEN}\n` };
    const config = loadApiConfig(
      { APP_ID: 'prior-authorization', DATABASE_URL_API: API_URL, BETTER_AUTH_SECRET: AUTH_SECRET, WORKER_SERVICE_TOKEN_FILE: '/run/secrets/token' },
      (path) => files[path] ?? noFiles(),
    );
    expect(config.workerServiceToken).toBe(TOKEN);
  });

  it('rejects conflicting inline and _FILE secrets by name, never by value', () => {
    const env: Env = { ...apiEnv, DATABASE_URL_API_FILE: '/run/secrets/api-url' };
    const message = messageOf(() => loadApiConfig(env, () => `${API_URL}\n`));
    expect(message).toContain('DATABASE_URL_API and DATABASE_URL_API_FILE are both set; set only one');
    expect(message).not.toContain('api-secret-value');
    expect(message).not.toContain('/run/secrets/api-url');
  });

  it('reports unreadable and empty secret files without their contents', () => {
    const unreadable = problemsOf(() =>
      loadApiConfig({ APP_ID: 'prior-authorization', DATABASE_URL_API: API_URL, BETTER_AUTH_SECRET: AUTH_SECRET, WORKER_SERVICE_TOKEN_FILE: '/missing' }, noFiles),
    );
    expect(unreadable).toEqual(['WORKER_SERVICE_TOKEN_FILE could not be read']);

    const empty = problemsOf(() =>
      loadApiConfig({ APP_ID: 'prior-authorization', DATABASE_URL_API: API_URL, BETTER_AUTH_SECRET: AUTH_SECRET, WORKER_SERVICE_TOKEN_FILE: '/empty' }, () => '\n'),
    );
    expect(empty).toEqual(['WORKER_SERVICE_TOKEN_FILE names an empty file']);
  });

  it('collects every problem, including missing and malformed secrets', () => {
    const message = messageOf(() =>
      loadWorkerConfig({ DATABASE_URL_WORKER: 'mysql://worker-secret-value@host/db', WORKER_SERVICE_TOKEN: 'short-secret', WORKER_CONCURRENCY: '0' }, noFiles),
    );
    expect(message).toContain('APP_ID is required');
    expect(message).toContain('DATABASE_URL_WORKER must be a postgres:// URL with a user name');
    expect(message).toContain('WORKER_SERVICE_TOKEN must be at least 32 characters');
    expect(message).toContain('WORKER_CONCURRENCY must be an integer from 1 to 16');
    expect(message).not.toContain('worker-secret-value');
    expect(message).not.toContain('short-secret');
  });

  it('keeps migrator credentials away from runtime services', () => {
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, DATABASE_URL_MIGRATOR_FILE: '/run/secrets/m' }, noFiles))).toEqual([
      'DATABASE_URL_MIGRATOR must not be provided to the API',
    ]);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, DATABASE_URL_MIGRATOR: API_URL }, noFiles))).toEqual([
      'DATABASE_URL_MIGRATOR must not be provided to the worker',
    ]);
    expect(loadMigratorConfig({ APP_ID: 'prior-authorization', DATABASE_URL_MIGRATOR: API_URL }, noFiles).databaseUrl).toBe(API_URL);
  });

  it.each([
    ['DATABASE_URL_ADMIN', ADMIN_URL],
    ['DATABASE_URL_ADMIN_FILE', '/run/secrets/admin'],
  ])('refuses the provisioning admin credentials (%s) in the API and the worker', (name, value) => {
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, [name]: value }, noFiles))).toEqual([
      'DATABASE_URL_ADMIN must not be provided to the API',
    ]);
    expect(problemsOf(() => loadWorkerConfig({ ...workerEnv, [name]: value }, noFiles))).toEqual([
      'DATABASE_URL_ADMIN must not be provided to the worker',
    ]);
  });

  it.each([
    ['DATABASE_URL_API', API_URL],
    ['DATABASE_URL_API_FILE', '/run/secrets/api'],
  ])('refuses the API database credentials (%s) in the worker', (name, value) => {
    const message = messageOf(() => loadWorkerConfig({ ...workerEnv, [name]: value }, noFiles));
    expect(message).toContain('DATABASE_URL_API must not be provided to the worker');
    expect(message).not.toContain('api-secret-value');
  });

  it.each([
    ['DATABASE_URL_WORKER', WORKER_URL],
    ['DATABASE_URL_WORKER_FILE', '/run/secrets/worker'],
  ])('refuses the worker database credentials (%s) in the API', (name, value) => {
    expect(problemsOf(() => loadApiConfig({ ...apiEnv, [name]: value }, noFiles))).toEqual([
      'DATABASE_URL_WORKER must not be provided to the API',
    ]);
  });
});
