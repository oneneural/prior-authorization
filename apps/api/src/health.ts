import { WORKER_HEARTBEAT_MAX_AGE_MS, type NotReadyReason, type ReadinessResponse, type WorkerHeartbeatReport } from '@pa/contracts';
import { checkApplicationSchema, queueSchemaVersion, type Database } from '@pa/db';

const DATABASE_CHECK_TIMEOUT_MS = 3_000;

// PostgreSQL error classes that mean the schema is not the one this build expects:
// undefined table or schema, insufficient privilege.
const SCHEMA_ERRORS = new Set(['42P01', '3F000', '42501']);

// Node socket errors from connecting to, or talking to, the database server.
const SOCKET_ERRORS = new Set(['ECONNREFUSED', 'ECONNRESET', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'EPIPE']);

// node-postgres messages for a lost or never-established connection. A full pool
// ("timeout exceeded when trying to connect") is deliberately absent: it means
// the API's own connections are busy, not that the server is unreachable.
const CONNECTION_MESSAGES = /^(Connection terminated|Client has encountered a connection error and is not queryable)/;

/** The error and its causes, outermost first (Drizzle wraps driver errors). */
function errorChain(error: unknown): Error[] {
  const chain: Error[] = [];
  for (let current = error; current instanceof Error && chain.length < 5 && !chain.includes(current); current = current.cause) {
    chain.push(current);
  }
  return chain;
}

/** The first error code in the chain: a PostgreSQL SQLSTATE or a Node error code. */
function errorCode(error: unknown): string | undefined {
  return errorChain(error)
    .map((entry) => (entry as { code?: unknown }).code)
    .find((code): code is string => typeof code === 'string');
}

/**
 * True only for connection-level failures: the server cannot be reached, closed
 * the connection, or is refusing connections (shutdown, startup, recovery). Query
 * timeouts, lock waits, pool exhaustion and other errors are not an outage.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  const code = errorCode(error);
  if (code !== undefined) {
    // Connection exceptions (08) and operator intervention such as admin shutdown (57P).
    return code.startsWith('08') || code.startsWith('57P') || SOCKET_ERRORS.has(code);
  }
  return errorChain(error).some((entry) => CONNECTION_MESSAGES.test(entry.message));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('database check timed out')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Readiness reason for a failed database check. */
export function databaseFailureReason(error: unknown): NotReadyReason {
  const code = errorCode(error);
  if (code !== undefined && SCHEMA_ERRORS.has(code)) {
    return 'schema_incompatible';
  }
  return isDatabaseUnavailable(error) ? 'database_unavailable' : 'database_check_failed';
}

/**
 * Process-local health state. Worker heartbeats are kept in memory only, so after
 * a restart nothing counts until the worker of this boot reports again; a stale
 * database heartbeat row from an earlier process can never satisfy readiness.
 */
export class Health {
  #draining = false;
  #heartbeat: { receivedAt: number; report: WorkerHeartbeatReport } | undefined;
  #queueSchemaVersion: number | undefined;

  constructor(
    private readonly db: Database,
    private readonly now: () => number = () => performance.now(),
  ) {}

  get draining(): boolean {
    return this.#draining;
  }

  /** Readiness turns false and new submissions are refused; internal routes stay open. */
  startDraining(): void {
    this.#draining = true;
  }

  recordHeartbeat(report: WorkerHeartbeatReport): void {
    this.#heartbeat = { receivedAt: this.now(), report };
  }

  /** Remembers the queue schema version the runtime instance started against. */
  async captureSchemaVersion(): Promise<void> {
    this.#queueSchemaVersion = await this.queueSchemaVersion();
  }

  private async queueSchemaVersion(): Promise<number> {
    const version = await queueSchemaVersion(this.db);
    if (version === undefined) {
      throw Object.assign(new Error('queue schema version missing'), { code: '42P01' });
    }
    return version;
  }

  private async databaseReason(): Promise<NotReadyReason | undefined> {
    try {
      await withTimeout(
        (async () => {
          await checkApplicationSchema(this.db);
          const version = await this.queueSchemaVersion();
          // Without a version captured at startup, the first successful read becomes the reference.
          this.#queueSchemaVersion ??= version;
          if (version !== this.#queueSchemaVersion) {
            throw Object.assign(new Error('queue schema version changed'), { code: '42P01' });
          }
        })(),
        DATABASE_CHECK_TIMEOUT_MS,
      );
      return undefined;
    } catch (error) {
      return databaseFailureReason(error);
    }
  }

  private heartbeatReason(): NotReadyReason | undefined {
    if (this.#heartbeat === undefined) {
      return 'worker_heartbeat_missing';
    }
    return this.now() - this.#heartbeat.receivedAt > WORKER_HEARTBEAT_MAX_AGE_MS ? 'worker_heartbeat_stale' : undefined;
  }

  async readiness(): Promise<ReadinessResponse> {
    const reasons: NotReadyReason[] = [];
    if (this.#draining) {
      reasons.push('shutting_down');
    }
    const database = await this.databaseReason();
    if (database !== undefined) {
      reasons.push(database);
    }
    const heartbeat = this.heartbeatReason();
    if (heartbeat !== undefined) {
      reasons.push(heartbeat);
    }
    return { ready: reasons.length === 0, reasons };
  }
}
