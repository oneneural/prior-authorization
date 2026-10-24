import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

import * as schema from './schema.js';

export type Database = NodePgDatabase<typeof schema>;
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0];
/** Either a pooled database handle or an open transaction. */
export type Queryable = Database | Transaction;

export interface DatabaseHandle {
  db: Database;
  pool: pg.Pool;
  close(): Promise<void>;
}

/** Bounds each new connection attempt, so a stopped or unreachable server fails fast. */
export const CONNECT_TIMEOUT_MS = 5_000;

export type PoolErrorLog = (error: Error) => void;

/**
 * An idle pooled client whose server goes away emits `error` on the pool. Without
 * a listener Node treats that as an unhandled error and the process exits, so a
 * database outage would crash the service instead of being reported as not ready.
 */
export function createDatabase(connectionString: string, applicationName: string, max = 5, onPoolError: PoolErrorLog = () => undefined): DatabaseHandle {
  const pool = new pg.Pool({ connectionString, application_name: applicationName, max, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  pool.on('error', onPoolError);
  const db = drizzle({ client: pool, schema });
  return { db, pool, close: () => pool.end() };
}
