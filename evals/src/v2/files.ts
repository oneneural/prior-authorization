import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

// File access for the v2 batch checks, loader and recipes. Every read
// goes through an injected `FileSystem`, so tests can record each access and
// prove that a rejected or refused fixture never touched a payload or a path
// outside its root.

export const REPO_ROOT = resolve(import.meta.dirname, '..', '..', '..');

export interface FileInfo {
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
  size: number;
}

export interface FileSystem {
  /** Never follows a final symbolic link. */
  lstat(path: string): Promise<FileInfo>;
  /** Resolves every symbolic link without opening the target. */
  realpath(path: string): Promise<string>;
  readFile(path: string): Promise<Uint8Array>;
  /** Entry names only. */
  readdir(path: string): Promise<string[]>;
}

export const nodeFileSystem: FileSystem = {
  lstat: (path) => lstat(path),
  realpath: (path) => realpath(path),
  readFile: (path) => readFile(path),
  readdir: (path) => readdir(path),
};

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** The `code` of a Node system error, or `undefined` for any other value. */
export const systemErrorCode = (error: unknown) => (error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : undefined);

export const isMissing = (error: unknown) => systemErrorCode(error) === 'ENOENT' || systemErrorCode(error) === 'ENOTDIR';

/** A symbolic link loop, which never resolves to a path inside a root. */
export const isLinkLoop = (error: unknown) => systemErrorCode(error) === 'ELOOP';

/**
 * Runs `check` and turns an unexpected system error (a permission error, for
 * example) into one content-free problem naming only `where` and the error
 * code, so the host path in Node's message never reaches a report. Any other
 * error is a defect and is rethrown.
 */
export async function contentFree<T>(where: string, check: () => Promise<T>, refuse: (problem: string) => T): Promise<T> {
  try {
    return await check();
  } catch (error) {
    const code = systemErrorCode(error);
    if (code === undefined) {
      throw error;
    }
    return refuse(`${where}: unexpected file system error (${code})`);
  }
}

/** `lstat`, or `null` when nothing exists at the path. */
export async function lstatOrNull(fs: FileSystem, path: string): Promise<FileInfo | null> {
  try {
    return await fs.lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw error;
  }
}

/** True when `path` is `root` or lies beneath it (both already canonical). */
export function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

const UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Strict UTF-8 decoding that keeps a byte order mark, or `null` for invalid bytes. */
export function decodeUtf8(bytes: Uint8Array): string | null {
  try {
    return UTF8.decode(bytes);
  } catch {
    return null;
  }
}

export const utf8Length = (text: string) => Buffer.byteLength(text, 'utf8');

/** Zod issues as content-free `path: message` lines; values are never quoted. */
export const describeIssues = (error: { issues: readonly { path: readonly PropertyKey[]; message: string }[] }) =>
  error.issues.map((issue) => `${issue.path.map(String).join('.') || '(root)'}: ${issue.message}`).join('; ');
