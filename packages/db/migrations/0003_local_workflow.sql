CREATE TABLE "pa_app"."document_requests" (
	"request_id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"case_revision" integer NOT NULL,
	"idempotency_key" text NOT NULL,
	"proposal_hash" text NOT NULL,
	"finding_id" text NOT NULL,
	"rule_id" text NOT NULL,
	"condition_keys" jsonb NOT NULL,
	"payload" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"approved_payload" jsonb,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	CONSTRAINT "document_requests_case_key" UNIQUE("case_id","idempotency_key")
);
--> statement-breakpoint
CREATE TABLE "pa_app"."local_receipts" (
	"receipt_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"mode" text DEFAULT 'scripted_fixture' NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_receipts_request_id_unique" UNIQUE("request_id")
);
--> statement-breakpoint
CREATE TABLE "pa_app"."review_decisions" (
	"decision_id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"role" text NOT NULL,
	"binding" jsonb NOT NULL,
	"decision" text NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pa_app"."workflow_commands" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"case_id" text NOT NULL,
	"operation" text NOT NULL,
	"payload_hash" text NOT NULL,
	"result" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pa_app"."workflow_responses" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"request_id" uuid NOT NULL,
	"case_id" text NOT NULL,
	"fixture_event" text NOT NULL,
	"snapshot" jsonb NOT NULL,
	"disposition" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pa_app"."cases" ADD COLUMN "current_job_id" uuid;--> statement-breakpoint
ALTER TABLE "pa_app"."document_requests" ADD CONSTRAINT "document_requests_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."local_receipts" ADD CONSTRAINT "local_receipts_request_id_document_requests_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "pa_app"."document_requests"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."review_decisions" ADD CONSTRAINT "review_decisions_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."workflow_commands" ADD CONSTRAINT "workflow_commands_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."workflow_responses" ADD CONSTRAINT "workflow_responses_request_id_document_requests_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "pa_app"."document_requests"("request_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pa_app"."workflow_responses" ADD CONSTRAINT "workflow_responses_case_id_cases_case_id_fk" FOREIGN KEY ("case_id") REFERENCES "pa_app"."cases"("case_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Preserve the selected assessment when upgrading already populated application databases.
UPDATE pa_app.cases AS c SET current_job_id = (
  SELECT a.job_id FROM pa_app.case_assessments AS a
  JOIN pa_app.case_events AS e ON e.correlation_id = a.job_id AND e.type = 'assessment_queued'
  WHERE a.case_id = c.case_id AND a.revision = c.revision
  ORDER BY e.sequence DESC LIMIT 1
);
--> statement-breakpoint
GRANT SELECT, INSERT ON pa_app.document_requests, pa_app.local_receipts, pa_app.review_decisions, pa_app.workflow_commands, pa_app.workflow_responses TO pa_api;
--> statement-breakpoint
GRANT UPDATE (state, approved_payload, approved_by, approved_at) ON pa_app.document_requests TO pa_api;
--> statement-breakpoint
CREATE FUNCTION pa_app.preserve_request_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_payload IS NOT NULL AND
     (NEW.approved_payload IS DISTINCT FROM OLD.approved_payload OR
      NEW.approved_by IS DISTINCT FROM OLD.approved_by OR
      NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
    RAISE EXCEPTION 'approved request payload is immutable';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER preserve_request_approval BEFORE UPDATE ON pa_app.document_requests
FOR EACH ROW EXECUTE FUNCTION pa_app.preserve_request_approval();
