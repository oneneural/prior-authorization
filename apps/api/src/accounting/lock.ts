import { randomUUID } from 'node:crypto';
import { readFileSync, readlinkSync } from 'node:fs';
import { link, open, readFile, rename, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { z } from 'zod';

import { ACCOUNTING_POLICY } from '@pa/agents/admission';

import { syncDirectory } from './durable.js';

/**
 * Fixed project-account writer lock beside the canonical ledger. Its name does
 * not depend on the ledger file name, so an alternate ledger in the same
 * directory cannot select a second lock. It is created exclusively, held for
 * the writer's lifetime and never expires by age.
 */
export const LOCK_FILE_NAME = `${ACCOUNTING_POLICY.accountId}.accounting.lock`;

export const ProcessIdentity = z.strictObject({
  host: z.string().max(256), pid: z.int().positive(), pidNamespace: z.string().max(80).nullable(), bootId: z.string().max(80).nullable(),
});
export type ProcessIdentity = z.infer<typeof ProcessIdentity>;

const LockRecord = z.strictObject({
  schemaVersion: z.literal('pa.accounting-lock.v1'),
  accountId: z.literal(ACCOUNTING_POLICY.accountId),
  ledgerPath: z.string().min(1).max(1024),
  token: z.uuid(),
  purpose: z.enum(['api', 'maintenance']),
  identity: ProcessIdentity,
  acquiredAt: z.iso.datetime(),
});
export type LockRecord = z.infer<typeof LockRecord>;

export type PredecessorState = 'stopped' | 'running' | 'unknown';

/** How a writer identifies itself and judges whether a recorded predecessor has stopped. */
export interface ProcessProbe {
  identity(): ProcessIdentity;
  predecessor(recorded: ProcessIdentity): PredecessorState;
}

const readOptional = (read: () => string) => { try { return read().trim(); } catch { return null; } };

/**
 * A predecessor is proven stopped only on the same host and PID namespace:
 * after a kernel reboot, or when no process holds its PID (ESRCH). A live PID
 * may be a reused one, and another host or namespace cannot be inspected, so
 * both stay unknown and keep live admission blocked.
 */
export const systemProbe: ProcessProbe = {
  identity: () => ({
    host: hostname(), pid: process.pid,
    pidNamespace: readOptional(() => readlinkSync('/proc/self/ns/pid')),
    bootId: readOptional(() => readFileSync('/proc/sys/kernel/random/boot_id', 'utf8')),
  }),
  predecessor(recorded) {
    const self = this.identity();
    if (recorded.host !== self.host || recorded.pidNamespace !== self.pidNamespace) return 'unknown';
    if (recorded.bootId !== null && self.bootId !== null && recorded.bootId !== self.bootId) return 'stopped';
    if (recorded.pid === self.pid) return 'running';
    try {
      process.kill(recorded.pid, 0);
      return 'running';
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'ESRCH' ? 'stopped' : 'running';
    }
  },
};

export class WriterLockUnavailable extends Error {
  override name = 'WriterLockUnavailable';
  constructor(readonly reason: 'writer_lock_held' | 'writer_lock_invalid' | 'writer_lock_lost' | 'writer_lock_io', message: string) {
    super(message);
  }
}

export interface WriterLock {
  readonly token: string;
  readonly path: string;
  /** The predecessor this writer replaced, if any, for the ledger history. */
  readonly replaced: LockRecord | null;
  /** Throws unless the lock file still names this writer. */
  verify(): Promise<void>;
  release(): Promise<void>;
}

async function readLock(path: string): Promise<LockRecord | 'missing' | 'invalid'> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw new WriterLockUnavailable('writer_lock_io', 'writer lock could not be read');
  }
  try {
    return LockRecord.parse(JSON.parse(text));
  } catch {
    return 'invalid';
  }
}

/**
 * Acquires exclusive writer ownership for `ledgerPath` (already resolved to its
 * real path). An existing lock is replaced only when its holder is proven
 * stopped, or when an operator running maintenance confirms it stopped.
 */
export async function acquireWriterLock(options: {
  ledgerPath: string; purpose: LockRecord['purpose']; probe?: ProcessProbe; now?: () => Date; confirmedPredecessorStopped?: boolean;
}): Promise<WriterLock> {
  const probe = options.probe ?? systemProbe;
  const directory = dirname(options.ledgerPath);
  const path = join(directory, LOCK_FILE_NAME);
  const record: LockRecord = {
    schemaVersion: 'pa.accounting-lock.v1', accountId: ACCOUNTING_POLICY.accountId, ledgerPath: options.ledgerPath, token: randomUUID(),
    purpose: options.purpose, identity: probe.identity(), acquiredAt: (options.now ?? (() => new Date()))().toISOString(),
  };
  const create = async () => {
    let handle;
    try {
      handle = await open(path, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw new WriterLockUnavailable('writer_lock_io', 'writer lock could not be created');
    }
    try {
      await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
    return true;
  };
  let replaced: LockRecord | null = null;
  let acquired = false;
  for (let attempt = 0; attempt < 3 && !acquired; attempt += 1) {
    if (await create()) { acquired = true; break; }
    const existing = await readLock(path);
    if (existing === 'missing') continue;
    if (existing === 'invalid') throw new WriterLockUnavailable('writer_lock_invalid', 'an unreadable writer lock exists; maintenance must inspect it');
    if (existing.ledgerPath !== options.ledgerPath) throw new WriterLockUnavailable('writer_lock_held', 'the account lock belongs to a different ledger path');
    const state = probe.predecessor(existing.identity);
    if (state !== 'stopped' && options.confirmedPredecessorStopped !== true) {
      throw new WriterLockUnavailable('writer_lock_held', `another writer holds the account lock (predecessor ${state})`);
    }
    // Only one successor can move the stale lock aside; a loser finds it gone and retries the exclusive create.
    const aside = `${path}.replaced-${record.token}`;
    try {
      await rename(path, aside);
    } catch {
      continue;
    }
    const moved = await readLock(aside);
    if (moved === 'missing' || moved === 'invalid' || moved.token !== existing.token) {
      // A competing successor replaced the stale lock first: put its lock back and stand down.
      await link(aside, path).catch(() => undefined);
      await unlink(aside).catch(() => undefined);
      throw new WriterLockUnavailable('writer_lock_held', 'another writer acquired the account lock first');
    }
    await unlink(aside).catch(() => undefined);
    replaced = existing;
  }
  if (!acquired) throw new WriterLockUnavailable('writer_lock_held', 'the account lock is held by another writer');

  const verify = async () => {
    const now = await readLock(path);
    if (now === 'missing' || now === 'invalid' || now.token !== record.token) throw new WriterLockUnavailable('writer_lock_lost', 'this process no longer holds the account lock');
  };
  return {
    token: record.token,
    path,
    replaced,
    verify,
    async release() {
      await verify();
      await unlink(path);
      await syncDirectory(directory);
    },
  };
}
