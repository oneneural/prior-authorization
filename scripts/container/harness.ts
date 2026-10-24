// Shared helpers for the container tests (`pnpm test:container`). Everything runs
// against a copy of the working tree in the system temporary directory, under
// its own Compose project and host port, so a user's deployment, `.env` and
// `.secrets/` are never read or changed.
import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { createGunzip, createZstdDecompress } from 'node:zlib';

const run = promisify(execFile);

export const PROJECT = 'prior-authorization-ctest';
export const HOST_PORT = 36105;
export const BASE_URL = `http://127.0.0.1:${HOST_PORT}`;
export const IMAGE = 'prior-authorization-app:ctest';
export const VIOLATION_IMAGE = 'prior-authorization-app:ctest-violation';
export const EXPORT_CONTAINER = `${PROJECT}-export`;
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const MAX_BUFFER = 64 * 1024 * 1024;

export function note(message: string): void {
  console.log(`[ctest] ${message}`);
}

export interface Context {
  dir: string;
  secretsDir: string;
  revision: string;
  /** Fixed per run: a changing build argument must not make Compose recreate containers. */
  created: string;
  /** Labelled secret values; scans report labels, never values. */
  needles: Map<string, string>;
  /** Image build output, kept for the secret scan. */
  buildOutput: string;
  /** Output of every project container, captured before Compose may replace it. */
  containerLogs: Map<string, string>;
}

export async function sh(file: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<string> {
  const { stdout } = await run(file, args, { cwd: options.cwd, env: options.env, maxBuffer: MAX_BUFFER, timeout: options.timeoutMs ?? 300_000 });
  return stdout;
}

/** Like sh, but returns the exit code and both streams instead of throwing. */
export async function shResult(file: string, args: string[], options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(file, args, { env: options.env, maxBuffer: MAX_BUFFER, timeout: options.timeoutMs ?? 300_000 });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const failure = error as { code?: number | string; stdout?: string; stderr?: string };
    return { code: typeof failure.code === 'number' ? failure.code : 1, stdout: failure.stdout ?? '', stderr: failure.stderr ?? '' };
  }
}

/**
 * Copies the working tree (tracked and untracked, not ignored) to a temporary
 * build context, generates secrets there and plants canary values in the secrets
 * directory and in `.env` files that the image and logs must never contain.
 */
export async function prepareContext(): Promise<Context> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-ctest-'));
  const listing = await sh('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: REPO });
  for (const path of listing.split('\0').filter(Boolean)) {
    const source = join(REPO, path);
    const stats = await lstat(source).catch(() => undefined);
    if (stats?.isFile()) {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await copyFile(source, join(dir, path));
      await chmod(join(dir, path), stats.mode & 0o777);
    }
  }
  const head = (await sh('git', ['rev-parse', 'HEAD'], { cwd: REPO })).trim();
  const dirty = (await sh('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: REPO })).trim() !== '';
  const revision = dirty ? `${head}-dirty` : head;

  const secretsDir = join(dir, '.secrets');
  await sh('sh', ['scripts/init-secrets.sh', '--dir', secretsDir], { cwd: dir });
  const needles = new Map<string, string>();
  for (const name of ['postgres_password', 'worker_service_token', 'better_auth_secret']) {
    needles.set(`secret ${name}`, (await readFile(join(secretsDir, name), 'utf8')).trim());
  }
  for (const role of ['migrator', 'api', 'worker']) {
    const url = new URL((await readFile(join(secretsDir, `database_url_${role}`), 'utf8')).trim());
    needles.set(`secret ${role} role password`, decodeURIComponent(url.password));
  }
  const canary = (where: string) => `PA-CANARY-${where}-${randomUUID()}`;
  const canaries = {
    'canary secrets file': canary('SECRETS'),
    'canary .env': canary('DOTENV'),
    'canary .env.local': canary('ENVLOCAL'),
    'canary apps/web/.env.production': canary('WEBENV'),
  };
  await writeFile(join(secretsDir, 'canary_token'), canaries['canary secrets file']);
  await writeFile(join(dir, '.env'), `PA_CANARY_TOKEN=${canaries['canary .env']}\n`);
  await writeFile(join(dir, '.env.local'), `PA_CANARY_TOKEN=${canaries['canary .env.local']}\n`);
  // Next.js would load this file and inline NEXT_PUBLIC_ values if it reached the build.
  await writeFile(join(dir, 'apps/web/.env.production'), `NEXT_PUBLIC_PA_CANARY=${canaries['canary apps/web/.env.production']}\n`);
  for (const [label, value] of Object.entries(canaries)) {
    needles.set(label, value);
  }
  return { dir, secretsDir, revision, created: new Date().toISOString(), needles, buildOutput: '', containerLogs: new Map() };
}

export interface ComposeOptions {
  env?: Record<string, string>;
  /** Extra override files, relative to the context directory. */
  files?: string[];
  timeoutMs?: number;
}

function composeEnv(context: Context, env: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    DOCKER_HOST: process.env.DOCKER_HOST,
    DOCKER_CONTEXT: process.env.DOCKER_CONTEXT,
    APP_HOST_PORT: String(HOST_PORT),
    PA_IMAGE_TAG: 'ctest',
    PA_SECRETS_DIR: context.secretsDir,
    PA_BUILD_REVISION: context.revision,
    PA_BUILD_CREATED: context.created,
    DATA_MODE: 'fixture',
    LOG_LEVEL: 'info',
    PA_CTEST_JOB_DELAY_MS: '0',
    PA_CTEST_WORKER_CONCURRENCY: '2',
    ...env,
  };
}

function composeArgs(context: Context, options: ComposeOptions, args: string[]): string[] {
  const files = ['compose.yaml', 'scripts/container/compose.ctest.yaml', ...(options.files ?? [])];
  return ['compose', '-p', PROJECT, ...files.flatMap((file) => ['-f', join(context.dir, file)]), ...args];
}

/** Captures the output of every project container, so the scan still sees containers that `up` or `down` removes. */
export async function keepContainerLogs(context: Context): Promise<void> {
  const ids = (await sh('docker', ['ps', '-a', '-q', '--no-trunc', '--filter', `label=com.docker.compose.project=${PROJECT}`])).trim().split('\n').filter(Boolean);
  for (const id of ids) {
    context.containerLogs.set(id, await logs(id));
  }
}

const REPLACES_CONTAINERS = new Set(['up', 'down']);

export async function compose(context: Context, args: string[], options: ComposeOptions = {}): Promise<string> {
  if (REPLACES_CONTAINERS.has(args[0] ?? '')) {
    await keepContainerLogs(context);
  }
  return sh('docker', composeArgs(context, options, args), { env: composeEnv(context, options.env), timeoutMs: options.timeoutMs });
}

export async function composeResult(context: Context, args: string[], options: ComposeOptions = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  if (REPLACES_CONTAINERS.has(args[0] ?? '')) {
    await keepContainerLogs(context);
  }
  return shResult('docker', composeArgs(context, options, args), { env: composeEnv(context, options.env), timeoutMs: options.timeoutMs });
}

export async function containerId(context: Context, service: string): Promise<string> {
  const id = (await compose(context, ['ps', '-a', '-q', service])).trim().split('\n')[0] ?? '';
  if (id === '') {
    throw new Error(`no ${service} container in ${PROJECT}`);
  }
  return id;
}

export interface ContainerInfo {
  Id: string;
  RestartCount: number;
  State: { Status: string; Running: boolean; ExitCode: number; StartedAt: string; Health?: { Status: string } };
  Config: { User: string; Env: string[]; Labels: Record<string, string>; StopTimeout?: number };
  HostConfig: {
    ReadonlyRootfs: boolean;
    CapDrop: string[] | null;
    CapAdd: string[] | null;
    SecurityOpt: string[] | null;
    Privileged: boolean;
    Init: boolean | null;
    PortBindings: Record<string, { HostIp: string; HostPort: string }[]> | null;
  };
  Mounts: { Type: string; Source: string; Destination: string; RW: boolean; Name?: string }[];
}

export async function inspect(id: string): Promise<ContainerInfo> {
  return (JSON.parse(await sh('docker', ['inspect', id])) as ContainerInfo[])[0]!;
}

export async function dockerExec(id: string, command: string[], timeoutMs = 60_000): Promise<string> {
  return sh('docker', ['exec', id, ...command], { timeoutMs });
}

/** Runs a Node script inside the app container and parses its JSON output. */
export async function nodeInContainer<T>(id: string, script: string): Promise<T> {
  return JSON.parse(await dockerExec(id, ['/usr/local/bin/node', '--input-type=module', '-e', script])) as T;
}

/**
 * PID of a supervised service as s6 records it, or undefined when it is down.
 * (Next.js renames its process title, so the command line cannot identify it.)
 */
export async function servicePid(id: string, service: string): Promise<number | undefined> {
  const pid = Number((await dockerExec(id, ['/command/s6-svstat', '-o', 'pid', `/run/service/${service}`])).trim());
  return pid > 0 ? pid : undefined;
}

export async function psql(context: Context, sql: string): Promise<string> {
  // Local socket inside the db container; used only to read test evidence.
  return (await dockerExec(await containerId(context, 'db'), ['psql', '-U', 'postgres', '-d', 'prior_authorization', '-Atc', sql])).trim();
}

const LOCK_APPLICATION = 'pa-ctest-lock';

/**
 * Holds an ACCESS EXCLUSIVE lock on one table from a separate session in the db
 * container, as an operator transaction left open would. Resolves once the lock
 * is granted; `release` ends that session.
 */
export async function lockTable(context: Context, table: string): Promise<{ release: () => Promise<void> }> {
  const db = await containerId(context, 'db');
  const sql = `BEGIN; LOCK TABLE ${table} IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(900);`;
  const child = spawn('docker', ['exec', '-e', `PGAPPNAME=${LOCK_APPLICATION}`, db, 'psql', '-U', 'postgres', '-d', 'prior_authorization', '-c', sql], { stdio: 'ignore' });
  const held = `SELECT count(*) FROM pg_locks JOIN pg_stat_activity USING (pid) WHERE application_name = '${LOCK_APPLICATION}' AND granted AND mode = 'AccessExclusiveLock'`;
  await waitFor(`the lock on ${table}`, async () => (Number(await psql(context, held)) > 0 ? true : undefined), 30_000, 250);
  return {
    release: async () => {
      await psql(context, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = '${LOCK_APPLICATION}'`);
      child.kill();
    },
  };
}

/** Container output with stdout and stderr interleaved in arrival order. */
export async function logs(id: string, since?: string): Promise<string> {
  const result = await shResult('sh', ['-c', 'exec docker logs "$@" 2>&1', 'sh', ...(since ? ['--since', since] : []), id]);
  return result.stdout;
}

/**
 * Like logs, one entry per line with Docker's timestamp for it. The timestamp is
 * on the daemon's clock, so it can bound a later `logs` call without host clock skew.
 */
export async function timestampedLogs(id: string, since?: string): Promise<{ time: string; text: string }[]> {
  const result = await shResult('sh', ['-c', 'exec docker logs --timestamps "$@" 2>&1', 'sh', ...(since ? ['--since', since] : []), id]);
  return result.stdout
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return { time: line.slice(0, space), text: line.slice(space + 1) };
    });
}

export interface DieEvent {
  exitCode: number;
  time: number;
}

/** `die` events of one container between two Unix times (seconds). */
export async function dieEvents(id: string, sinceSeconds: number, untilSeconds = Math.ceil(Date.now() / 1000) + 1): Promise<DieEvent[]> {
  const output = await sh('docker', ['events', '--since', String(sinceSeconds), '--until', String(untilSeconds), '--filter', `container=${id}`, '--filter', 'event=die', '--format', '{{json .}}']);
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as { timeNano: number; Actor: { Attributes: Record<string, string> } };
      return { exitCode: Number(event.Actor.Attributes.exitCode), time: event.timeNano / 1e9 };
    });
}

export async function waitFor<T>(what: string, check: () => Promise<T | undefined>, timeoutMs: number, intervalMs = 1_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    try {
      const value = await check();
      if (value !== undefined) {
        return value;
      }
    } catch (error) {
      lastError = error;
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${lastError ? ` (last error: ${(lastError as Error).message})` : ''}`);
    }
    await delay(intervalMs);
  }
}

export async function waitHealthy(context: Context, timeoutMs = 180_000): Promise<ContainerInfo> {
  return waitFor(
    'a healthy app container',
    async () => {
      const info = await inspect(await containerId(context, 'app'));
      return info.State.Health?.Status === 'healthy' ? info : undefined;
    },
    timeoutMs,
  );
}

export interface HttpResult {
  status: number;
  text: string;
  json: unknown;
  /** The Location header, for requests made with `redirect: 'manual'`. */
  location: string | null;
}

export async function http(path: string, init: RequestInit = {}): Promise<HttpResult> {
  const response = await fetch(new URL(path, BASE_URL), { ...init, signal: AbortSignal.timeout(10_000) });
  const text = await response.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, location: response.headers.get('location') };
}

export async function submitProbe(label: string): Promise<HttpResult> {
  return http('/api/pilot/probes', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `ctest-${randomUUID()}` },
    body: JSON.stringify({ label }),
  });
}

export async function probeStatus(probeId: string): Promise<string | undefined> {
  const status = await http('/api/status');
  const probes = (status.json as { probes?: { probeId: string; status: string }[] } | undefined)?.probes ?? [];
  return probes.find((probe) => probe.probeId === probeId)?.status;
}

// --- Secret scanning -------------------------------------------------------

export interface Finding {
  label: string;
  where: string;
}

/** Searches byte streams for the needles, across chunk boundaries. */
export class Scanner {
  readonly findings: Finding[] = [];
  readonly #needles: [string, Buffer][];
  readonly #overlap: number;

  constructor(needles: Map<string, string>) {
    this.#needles = [...needles].map(([label, value]) => [label, Buffer.from(value)]);
    this.#overlap = Math.max(...this.#needles.map(([, value]) => value.length)) - 1;
  }

  #record(label: string, where: string): void {
    if (!this.findings.some((finding) => finding.label === label && finding.where === where)) {
      this.findings.push({ label, where });
    }
  }

  text(content: string | Buffer, where: string): void {
    const buffer = typeof content === 'string' ? Buffer.from(content) : content;
    for (const [label, value] of this.#needles) {
      if (buffer.includes(value)) {
        this.#record(label, where);
      }
    }
  }

  async stream(source: Readable, where: string): Promise<number> {
    let tail: Buffer = Buffer.alloc(0);
    let total = 0;
    for await (const chunk of source) {
      const buffer = chunk as Buffer;
      total += buffer.length;
      this.text(Buffer.concat([tail, buffer]), where);
      tail = buffer.subarray(Math.max(0, buffer.length - this.#overlap));
    }
    return total;
  }
}

/** Scans the filesystem of a stopped container created from the image (`docker export`). */
export async function scanExport(scanner: Scanner, image: string, where: string): Promise<number> {
  await shResult('docker', ['rm', '-f', EXPORT_CONTAINER]);
  await sh('docker', ['create', '--name', EXPORT_CONTAINER, image]);
  try {
    const child = spawn('docker', ['export', EXPORT_CONTAINER], { stdio: ['ignore', 'pipe', 'inherit'] });
    const exited = new Promise<number>((resolve) => child.on('close', (code) => resolve(code ?? 1)));
    const bytes = await scanner.stream(child.stdout, where);
    if ((await exited) !== 0) {
      throw new Error('docker export failed');
    }
    return bytes;
  } finally {
    await shResult('docker', ['rm', '-f', EXPORT_CONTAINER]);
  }
}

/**
 * Saves the image and scans every file of the archive: each layer blob after
 * decompression (gzip or zstd, as the containerd store may keep either), plus
 * the manifests and the image configuration with its history, environment and
 * labels. Returns the number of compressed layers scanned.
 */
export async function scanSavedImage(scanner: Scanner, image: string, where: string): Promise<{ layers: number; files: number }> {
  const dir = await mkdtemp(join(tmpdir(), 'pa-ctest-save-'));
  const archive = join(dir, 'image.tar');
  try {
    await sh('docker', ['save', '-o', archive, image], { timeoutMs: 600_000 });
    const handle = await open(archive, 'r');
    let offset = 0;
    let layers = 0;
    let files = 0;
    try {
      const header = Buffer.alloc(512);
      for (;;) {
        const { bytesRead } = await handle.read(header, 0, 512, offset);
        if (bytesRead < 512 || header.every((byte) => byte === 0)) {
          break;
        }
        const field = (start: number, length: number) => header.subarray(start, start + length).toString('utf8').replace(/\0.*$/s, '');
        const name = `${field(345, 155) ? `${field(345, 155)}/` : ''}${field(0, 100)}`;
        const size = Number.parseInt(field(124, 12).trim() || '0', 8);
        const type = field(156, 1);
        offset += 512;
        if (size > 0 && (type === '0' || type === '' || type === 'x')) {
          files += 1;
          const magic = Buffer.alloc(4);
          await handle.read(magic, 0, 4, offset);
          const raw = createReadStream(archive, { start: offset, end: offset + size - 1 });
          if (magic[0] === 0x1f && magic[1] === 0x8b) {
            layers += 1;
            await scanner.stream(raw.pipe(createGunzip()), `${where}: ${name}`);
          } else if (magic.equals(Buffer.from([0x28, 0xb5, 0x2f, 0xfd]))) {
            layers += 1;
            await scanner.stream(raw.pipe(createZstdDecompress()), `${where}: ${name}`);
          } else {
            await scanner.stream(raw, `${where}: ${name}`);
          }
        }
        offset += Math.ceil(size / 512) * 512;
      }
    } finally {
      await handle.close();
    }
    return { layers, files };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Fetches the page and every script and stylesheet it references. */
export async function servedFiles(): Promise<Map<string, string>> {
  const served = new Map<string, string>();
  const page = await http('/');
  served.set('/', page.text);
  for (const path of ['/api/status', '/api/health/ready', '/api/health/live']) {
    served.set(path, (await http(path)).text);
  }
  const assets = new Set([...page.text.matchAll(/(?:src|href)="(\/_next\/[^"]+)"/g)].map((match) => match[1]!));
  for (const asset of assets) {
    served.set(asset, (await http(asset)).text);
  }
  return served;
}

export async function removeContext(context: Context | undefined): Promise<void> {
  if (context !== undefined) {
    await rm(context.dir, { recursive: true, force: true });
  }
}

export async function writeContextFile(context: Context, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(context.dir, path)), { recursive: true });
  await writeFile(join(context.dir, path), content);
}
