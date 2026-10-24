-- Object grants for runtime roles. Roles are created by provisioning before
-- migrations run; the migrator owns every object and runtime roles get no DDL.
-- The API role writes application data; the worker role sees only its heartbeat.
REVOKE ALL ON SCHEMA "pa_app" FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON SCHEMA "pa_worker" FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA "pa_app" TO "pa_api";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pa_app"."pilot_probes" TO "pa_api";
--> statement-breakpoint
GRANT USAGE ON SCHEMA "pa_worker" TO "pa_worker";
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON "pa_worker"."worker_heartbeats" TO "pa_worker";
