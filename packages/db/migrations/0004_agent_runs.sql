CREATE TABLE "pa_app"."agent_proposals" (
	"proposal_id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"proposal_key" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb,
	"payload_hash" text NOT NULL,
	"status" text NOT NULL,
	"code" text,
	"review" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_proposals_run_key" UNIQUE("run_id","proposal_key")
);
--> statement-breakpoint
CREATE TABLE "pa_app"."agent_runs" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"case_revision" integer NOT NULL,
	"binding" jsonb NOT NULL,
	"provider" text NOT NULL,
	"label" text NOT NULL,
	"recording_id" text,
	"versions" jsonb NOT NULL,
	"thread_id" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"pending_job_id" uuid,
	"stop_reason" text,
	"failure_code" text,
	"model_identity" jsonb,
	"trace" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"review_event_id" uuid,
	"outcome" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_runs_thread_id_unique" UNIQUE("thread_id")
);
--> statement-breakpoint
ALTER TABLE "pa_app"."agent_proposals" ADD CONSTRAINT "agent_proposals_run_id_agent_runs_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "pa_app"."agent_runs"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."agent_runs" ADD CONSTRAINT "agent_runs_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Proposals and runs are append-mostly: the API changes only lifecycle columns.
GRANT SELECT, INSERT ON pa_app.agent_runs, pa_app.agent_proposals TO pa_api;
--> statement-breakpoint
GRANT UPDATE (state, pending_job_id, stop_reason, failure_code, model_identity, trace, review_event_id, outcome, updated_at) ON pa_app.agent_runs TO pa_api;
--> statement-breakpoint
GRANT UPDATE (review) ON pa_app.agent_proposals TO pa_api;
