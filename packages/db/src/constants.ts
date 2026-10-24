// Fixed database identities. Reviewed migrations and grant SQL reference these
// role names directly, so provisioning refuses URLs that name other roles.
export const ROLES = {
  migrator: 'pa_migrator',
  api: 'pa_api',
  worker: 'pa_worker',
} as const;

export const PGBOSS_SCHEMA = 'pgboss';
export const MIGRATIONS_SCHEMA = 'pa_migrations';
/** LangGraph checkpoints: created by the migrator, read and written only by the worker role. */
export const CHECKPOINT_SCHEMA = 'pa_checkpoint';
export const PILOT_QUEUE = 'pilot-probe';

/** Queue policy created by the migrator; runtime roles cannot create or alter queues. */
export const PILOT_QUEUE_OPTIONS = {
  policy: 'standard',
  retryLimit: 3,
  retryDelay: 2,
  expireInSeconds: 60,
  retentionSeconds: 24 * 60 * 60,
  deleteAfterSeconds: 7 * 24 * 60 * 60,
} as const;
