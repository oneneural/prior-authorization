CREATE TABLE "pa_app"."case_assessments" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"revision" integer NOT NULL,
	"outcome" jsonb,
	"packet" jsonb
);
--> statement-breakpoint
CREATE TABLE "pa_app"."case_blobs" (
	"hash" text PRIMARY KEY NOT NULL,
	"content" text NOT NULL,
	CONSTRAINT "case_blobs_hash_check" CHECK ("pa_app"."case_blobs"."hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "pa_app"."case_documents" (
	"case_id" text NOT NULL,
	"document_id" text NOT NULL,
	"version" integer NOT NULL,
	"metadata_text" text NOT NULL,
	"blob_hash" text,
	CONSTRAINT "case_documents_case_id_document_id_version_pk" PRIMARY KEY("case_id","document_id","version"),
	CONSTRAINT "case_documents_version_check" CHECK ("pa_app"."case_documents"."version" > 0)
);
--> statement-breakpoint
CREATE TABLE "pa_app"."case_events" (
	"sequence" bigserial PRIMARY KEY NOT NULL,
	"event_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"type" text NOT NULL,
	"actor" text NOT NULL,
	"input_revision" integer NOT NULL,
	"payload_hash" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "case_events_event_id_unique" UNIQUE("event_id")
);
--> statement-breakpoint
CREATE TABLE "pa_app"."case_revisions" (
	"case_id" text NOT NULL,
	"revision" integer NOT NULL,
	"case_text" text NOT NULL,
	"policy_hash" text NOT NULL,
	"document_refs" jsonb NOT NULL,
	CONSTRAINT "case_revisions_case_id_revision_pk" PRIMARY KEY("case_id","revision"),
	CONSTRAINT "case_revisions_revision_check" CHECK ("pa_app"."case_revisions"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "pa_app"."cases" (
	"case_id" text PRIMARY KEY NOT NULL,
	"owner_id" text NOT NULL,
	"revision" integer NOT NULL,
	"state" text DEFAULT 'intake' NOT NULL,
	CONSTRAINT "cases_revision_check" CHECK ("pa_app"."cases"."revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "pa_app"."case_assessments" ADD CONSTRAINT "case_assessments_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_assessments" ADD CONSTRAINT "case_assessments_case_id_revision_fkey" FOREIGN KEY ("case_id","revision") REFERENCES "pa_app"."case_revisions"("case_id","revision") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_documents" ADD CONSTRAINT "case_documents_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_documents" ADD CONSTRAINT "case_documents_blob_hash_case_blobs_hash_fk" FOREIGN KEY ("blob_hash") REFERENCES "pa_app"."case_blobs"("hash") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_events" ADD CONSTRAINT "case_events_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_revisions" ADD CONSTRAINT "case_revisions_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "pa_app"."case_revisions" ADD CONSTRAINT "case_revisions_policy_hash_case_blobs_hash_fk" FOREIGN KEY ("policy_hash") REFERENCES "pa_app"."case_blobs"("hash") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
GRANT SELECT, INSERT ON pa_app.case_blobs, pa_app.case_documents, pa_app.case_revisions, pa_app.case_events TO pa_api;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON pa_app.cases, pa_app.case_assessments TO pa_api;
--> statement-breakpoint
GRANT USAGE, SELECT ON SEQUENCE pa_app.case_events_sequence_seq TO pa_api;
