import { PostgresSaver } from '@langchain/langgraph-checkpoint-postgres';
import pg from 'pg';

/**
 * Worker-role checkpointer. The migrator creates the schema and tables; the
 * runtime never calls `setup()` because the worker role owns no objects.
 */
export function createCheckpointer(connectionString: string, schema: string): { saver: PostgresSaver; close(): Promise<void> } {
  const pool = new pg.Pool({ connectionString, max: 2, application_name: 'pa-worker-checkpoints' });
  return { saver: new PostgresSaver(pool, undefined, { schema }), close: () => pool.end() };
}
