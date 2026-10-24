CREATE SCHEMA "pa_app";
--> statement-breakpoint
CREATE SCHEMA "pa_worker";
--> statement-breakpoint
CREATE TYPE "pa_app"."pilot_probe_status" AS ENUM('queued', 'completed');--> statement-breakpoint
CREATE TABLE "pa_app"."pilot_probes" (
	"probe_id" uuid PRIMARY KEY NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"label" text NOT NULL,
	"synthetic" boolean DEFAULT true NOT NULL,
	"status" "pa_app"."pilot_probe_status" DEFAULT 'queued' NOT NULL,
	"job_id" uuid NOT NULL,
	"worker_result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "pilot_probes_idempotency_key_unique" UNIQUE("idempotency_key"),
	CONSTRAINT "pilot_probes_job_id_unique" UNIQUE("job_id"),
	CONSTRAINT "pilot_probes_synthetic_only" CHECK ("pa_app"."pilot_probes"."synthetic"),
	CONSTRAINT "pilot_probes_completion_consistent" CHECK (("pa_app"."pilot_probes"."status" = 'completed') = ("pa_app"."pilot_probes"."worker_result" IS NOT NULL AND "pa_app"."pilot_probes"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "pa_worker"."worker_heartbeats" (
	"worker_id" text PRIMARY KEY NOT NULL,
	"boot_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"last_job_id" uuid
);
