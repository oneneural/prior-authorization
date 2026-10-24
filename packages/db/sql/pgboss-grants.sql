-- Runtime grants on the pg-boss 12.38.0 schema, applied by the migrator after
-- it installs the schema and creates the pilot queue. Discovered by running the
-- API producer and worker consumer with only schema USAGE and adding the
-- privilege each failing statement needed (recorded in docs/development.md).
-- pg-boss reads and writes the queue's partition (job_common, because the
-- pilot queue is created with partition = false) directly, so it is granted
-- alongside the partitioned parent. No role below owns or can alter an object.
GRANT USAGE ON SCHEMA pgboss TO pa_api, pa_worker;

-- Startup version check and queue cache.
GRANT SELECT ON pgboss.version, pgboss.queue TO pa_api, pa_worker;

-- API producer: send() inserts jobs; getJobById() verifies the active job
-- before a worker result is accepted.
GRANT SELECT, INSERT ON pgboss.job, pgboss.job_common TO pa_api;

-- Worker consumer: fetch/complete update jobs; fail, retry and expiry delete
-- the job and re-insert it in its next state.
GRANT SELECT, INSERT, UPDATE, DELETE ON pgboss.job, pgboss.job_common TO pa_worker;

-- Worker supervision: queue and version maintenance timestamps, flow cleanup and
-- pruning of stale instance-registry rows (pruning locks rows FOR UPDATE).
GRANT UPDATE ON pgboss.queue, pgboss.version TO pa_worker;
GRANT SELECT, DELETE ON pgboss.job_dependency TO pa_worker;
GRANT SELECT, UPDATE, DELETE ON pgboss.instance TO pa_worker;

-- Functions. None is SECURITY DEFINER; runtime SQL calls only job_now(). The
-- partition and queue helpers (create_queue, delete_queue, job_table_*) are
-- migration-time only, so PUBLIC's default EXECUTE is revoked. This file runs
-- after every migration, so functions added by a later pg-boss version are
-- revoked again.
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA pgboss FROM PUBLIC;
GRANT EXECUTE ON FUNCTION pgboss.job_now() TO pa_api, pa_worker;
