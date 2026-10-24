import type { Database } from '@pa/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { databaseFailureReason, Health, isDatabaseUnavailable } from './health.js';

const withCode = (code: string, message = 'failed') => Object.assign(new Error(message), { code });

describe('database failure classification', () => {
  it.each([
    ['refused connection', withCode('ECONNREFUSED')],
    ['unknown host', withCode('ENOTFOUND')],
    ['DNS retry', withCode('EAI_AGAIN')],
    ['reset socket', withCode('ECONNRESET')],
    ['connect timeout from the socket', withCode('ETIMEDOUT')],
    ['connection exception', withCode('08006')],
    ['admin shutdown', withCode('57P01')],
    ['server starting up', withCode('57P03')],
    ['wrapped query error', new Error('Failed query: select 1', { cause: withCode('ENOTFOUND') })],
    ['lost connection', new Error('Connection terminated unexpectedly')],
    ['connect timeout from the pool', new Error('Connection terminated due to connection timeout')],
    ['broken client', new Error('Client has encountered a connection error and is not queryable')],
  ])('reports %s as database_unavailable', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(true);
    expect(databaseFailureReason(error)).toBe('database_unavailable');
  });

  it.each([
    ['the readiness check timeout', new Error('database check timed out')],
    ['a full connection pool', new Error('timeout exceeded when trying to connect')],
    ['a cancelled statement', withCode('57014')],
    ['a lock wait failure', withCode('55P03')],
    ['too many connections', withCode('53300')],
    ['a file descriptor limit', withCode('EMFILE')],
    ['a permission error', withCode('EACCES')],
    ['a full disk', withCode('ENOSPC')],
    ['a programming error', new TypeError('cannot read properties of undefined')],
    ['a non-error value', 'failed'],
  ])('reports %s as database_check_failed', (_name, error) => {
    expect(isDatabaseUnavailable(error)).toBe(false);
    expect(databaseFailureReason(error)).toBe('database_check_failed');
  });

  it.each([
    ['a missing table', withCode('42P01')],
    ['a missing schema behind a query wrapper', new Error('Failed query: select 1', { cause: withCode('3F000') })],
    ['a missing privilege', withCode('42501')],
  ])('reports %s as schema_incompatible', (_name, error) => {
    expect(databaseFailureReason(error)).toBe('schema_incompatible');
  });
});

describe('readiness', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('reports a database check that never answers (a lock wait) as database_check_failed, not an outage', async () => {
    vi.useFakeTimers();
    const blocked = { execute: () => new Promise(() => undefined) } as unknown as Database;
    const pending = new Health(blocked).readiness();
    await vi.advanceTimersByTimeAsync(3_000);
    await expect(pending).resolves.toEqual({ ready: false, reasons: ['database_check_failed', 'worker_heartbeat_missing'] });
  });
});
