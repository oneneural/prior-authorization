import { randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** The ordered steps of one durable replacement; tests inject failures at each. */
export type DurableStep = 'create' | 'write' | 'fsync' | 'rename' | 'dirsync';
export type FaultHook = (step: DurableStep) => void | Promise<void>;

/**
 * The replacement did not confirm. `before_rename` leaves the canonical file
 * unchanged; `after_rename` means it may already hold the new content, so the
 * outcome is uncertain and admission must stop either way.
 */
export class DurableWriteFailed extends Error {
  override name = 'DurableWriteFailed';
  constructor(readonly phase: 'before_rename' | 'after_rename') {
    super(`ledger replacement failed ${phase.replace('_', ' ')}`);
  }
}

export const isTemporaryName = (ledgerPath: string, name: string) => name.startsWith(`.${basename(ledgerPath)}.`) && name.endsWith('.tmp');

export async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Restricted temporary file in the same directory, fsync, atomic rename over
 * the canonical file, then fsync of the parent directory. Success is returned
 * only after every step confirmed. A surviving temporary file is never read
 * back as accounting.
 */
export async function durableReplace(path: string, contents: string, fault: FaultHook = () => undefined): Promise<void> {
  const directory = dirname(path);
  const temporary = join(directory, `.${basename(path)}.${randomUUID()}.tmp`);
  let handle;
  try {
    await fault('create');
    handle = await open(temporary, 'wx', 0o600);
    await fault('write');
    await handle.writeFile(contents, 'utf8');
    await fault('fsync');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fault('rename');
    await rename(temporary, path);
  } catch {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw new DurableWriteFailed('before_rename');
  }
  try {
    await fault('dirsync');
    await syncDirectory(directory);
  } catch {
    throw new DurableWriteFailed('after_rename');
  }
}
