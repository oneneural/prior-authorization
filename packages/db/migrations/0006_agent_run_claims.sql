ALTER TABLE "pa_app"."agent_runs" ADD COLUMN "claim_id" uuid;--> statement-breakpoint
-- Only the API records which worker claim moved a job to running.
GRANT UPDATE (claim_id) ON pa_app.agent_runs TO pa_api;
