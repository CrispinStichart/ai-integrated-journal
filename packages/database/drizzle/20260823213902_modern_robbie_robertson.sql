CREATE TYPE "public"."nudge_action_kind" AS ENUM('answer', 'defer', 'dismiss', 'not_applicable');--> statement-breakpoint
CREATE TYPE "public"."nudge_digest_status" AS ENUM('queued', 'published', 'deferred', 'dismissed', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."requirement_evaluation_state" AS ENUM('not_evaluated', 'satisfied', 'insufficient_information', 'pending_user_response', 'dismissed', 'not_applicable', 'failed');--> statement-breakpoint
CREATE TABLE "journal"."nudge_action" (
	"id" uuid PRIMARY KEY NOT NULL,
	"digest_id" uuid NOT NULL,
	"item_id" uuid,
	"actor_id" uuid NOT NULL,
	"action" "nudge_action_kind" NOT NULL,
	"response_contribution_id" uuid NOT NULL,
	"deferred_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudge_action_id_uuid_v7" CHECK (substring("journal"."nudge_action"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "nudge_action_item_consistent" CHECK (("journal"."nudge_action"."action" in ('answer', 'not_applicable') and "journal"."nudge_action"."item_id" is not null) or ("journal"."nudge_action"."action" in ('defer', 'dismiss') and "journal"."nudge_action"."item_id" is null)),
	CONSTRAINT "nudge_action_defer_consistent" CHECK (("journal"."nudge_action"."action" = 'defer' and "journal"."nudge_action"."deferred_until" is not null) or ("journal"."nudge_action"."action" <> 'defer' and "journal"."nudge_action"."deferred_until" is null))
);
--> statement-breakpoint
CREATE TABLE "journal"."nudge_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"digest_id" uuid NOT NULL,
	"action_id" uuid NOT NULL,
	"response_contribution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudge_api_idempotency_operation_not_blank" CHECK (length("journal"."nudge_api_idempotency"."operation") > 0),
	CONSTRAINT "nudge_api_idempotency_key_not_blank" CHECK (length("journal"."nudge_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "nudge_api_idempotency_request_hash_sha256" CHECK ("journal"."nudge_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."nudge_digest" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"journal_day_id" uuid NOT NULL,
	"notification_date" date NOT NULL,
	"status" "nudge_digest_status" DEFAULT 'queued' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"published_at" timestamp with time zone,
	"deferred_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudge_digest_id_uuid_v7" CHECK (substring("journal"."nudge_digest"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "nudge_digest_revision_positive" CHECK ("journal"."nudge_digest"."revision" > 0),
	CONSTRAINT "nudge_digest_published_consistent" CHECK (("journal"."nudge_digest"."status" = 'published' and "journal"."nudge_digest"."published_at" is not null) or ("journal"."nudge_digest"."status" <> 'published')),
	CONSTRAINT "nudge_digest_deferred_consistent" CHECK (("journal"."nudge_digest"."status" = 'deferred' and "journal"."nudge_digest"."deferred_until" is not null) or ("journal"."nudge_digest"."status" <> 'deferred' and "journal"."nudge_digest"."deferred_until" is null))
);
--> statement-breakpoint
CREATE TABLE "journal"."nudge_item" (
	"id" uuid PRIMARY KEY NOT NULL,
	"digest_id" uuid NOT NULL,
	"evaluation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudge_item_id_uuid_v7" CHECK (substring("journal"."nudge_item"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "journal"."nudge_preference" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"quiet_start_hour" integer DEFAULT 21 NOT NULL,
	"quiet_end_hour" integer DEFAULT 8 NOT NULL,
	"daily_limit" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "nudge_preference_hours_valid" CHECK ("journal"."nudge_preference"."quiet_start_hour" between 0 and 23 and "journal"."nudge_preference"."quiet_end_hour" between 0 and 23 and "journal"."nudge_preference"."quiet_start_hour" <> "journal"."nudge_preference"."quiet_end_hour"),
	CONSTRAINT "nudge_preference_daily_limit_valid" CHECK ("journal"."nudge_preference"."daily_limit" between 0 and 24)
);
--> statement-breakpoint
CREATE TABLE "journal"."requirement_evaluation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_day_id" uuid NOT NULL,
	"processor_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"supporting_run_id" uuid,
	"state" "requirement_evaluation_state" DEFAULT 'not_evaluated' NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"manual_resolution" boolean DEFAULT false NOT NULL,
	"response_contribution_id" uuid,
	"evaluated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "requirement_evaluation_id_uuid_v7" CHECK (substring("journal"."requirement_evaluation"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "requirement_evaluation_revision_positive" CHECK ("journal"."requirement_evaluation"."revision" > 0),
	CONSTRAINT "requirement_evaluation_manual_consistent" CHECK (("journal"."requirement_evaluation"."manual_resolution" = false and "journal"."requirement_evaluation"."response_contribution_id" is null) or ("journal"."requirement_evaluation"."manual_resolution" = true and "journal"."requirement_evaluation"."state" in ('satisfied', 'dismissed', 'not_applicable') and "journal"."requirement_evaluation"."response_contribution_id" is not null)),
	CONSTRAINT "requirement_evaluation_run_consistent" CHECK (("journal"."requirement_evaluation"."state" = 'not_evaluated' and "journal"."requirement_evaluation"."evaluated_at" is null) or ("journal"."requirement_evaluation"."state" <> 'not_evaluated' and "journal"."requirement_evaluation"."evaluated_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."nudge_action" ADD CONSTRAINT "nudge_action_digest_id_nudge_digest_id_fk" FOREIGN KEY ("digest_id") REFERENCES "journal"."nudge_digest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_action" ADD CONSTRAINT "nudge_action_item_id_nudge_item_id_fk" FOREIGN KEY ("item_id") REFERENCES "journal"."nudge_item"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_action" ADD CONSTRAINT "nudge_action_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_action" ADD CONSTRAINT "nudge_action_response_contribution_id_contribution_id_fk" FOREIGN KEY ("response_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_api_idempotency" ADD CONSTRAINT "nudge_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_api_idempotency" ADD CONSTRAINT "nudge_api_idempotency_digest_id_nudge_digest_id_fk" FOREIGN KEY ("digest_id") REFERENCES "journal"."nudge_digest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_api_idempotency" ADD CONSTRAINT "nudge_api_idempotency_action_id_nudge_action_id_fk" FOREIGN KEY ("action_id") REFERENCES "journal"."nudge_action"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_api_idempotency" ADD CONSTRAINT "nudge_api_idempotency_response_contribution_id_contribution_id_fk" FOREIGN KEY ("response_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_digest" ADD CONSTRAINT "nudge_digest_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_digest" ADD CONSTRAINT "nudge_digest_journal_day_id_journal_day_id_fk" FOREIGN KEY ("journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_item" ADD CONSTRAINT "nudge_item_digest_id_nudge_digest_id_fk" FOREIGN KEY ("digest_id") REFERENCES "journal"."nudge_digest"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_item" ADD CONSTRAINT "nudge_item_evaluation_id_requirement_evaluation_id_fk" FOREIGN KEY ("evaluation_id") REFERENCES "journal"."requirement_evaluation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."nudge_preference" ADD CONSTRAINT "nudge_preference_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."requirement_evaluation" ADD CONSTRAINT "requirement_evaluation_journal_day_id_journal_day_id_fk" FOREIGN KEY ("journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."requirement_evaluation" ADD CONSTRAINT "requirement_evaluation_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."requirement_evaluation" ADD CONSTRAINT "requirement_evaluation_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."requirement_evaluation" ADD CONSTRAINT "requirement_evaluation_supporting_run_id_processor_run_id_fk" FOREIGN KEY ("supporting_run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."requirement_evaluation" ADD CONSTRAINT "requirement_evaluation_response_contribution_id_contribution_id_fk" FOREIGN KEY ("response_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_action_response_contribution_unique" ON "journal"."nudge_action" USING btree ("response_contribution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_api_idempotency_owner_operation_key_unique" ON "journal"."nudge_api_idempotency" USING btree ("owner_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_digest_journal_day_unique" ON "journal"."nudge_digest" USING btree ("journal_day_id");--> statement-breakpoint
CREATE INDEX "nudge_digest_delivery_idx" ON "journal"."nudge_digest" USING btree ("status","scheduled_at");--> statement-breakpoint
CREATE INDEX "nudge_digest_owner_notification_date_idx" ON "journal"."nudge_digest" USING btree ("owner_id","notification_date");--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_item_digest_evaluation_unique" ON "journal"."nudge_item" USING btree ("digest_id","evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "nudge_item_evaluation_unique" ON "journal"."nudge_item" USING btree ("evaluation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "requirement_evaluation_day_version_unique" ON "journal"."requirement_evaluation" USING btree ("journal_day_id","processor_version_id");--> statement-breakpoint
CREATE INDEX "requirement_evaluation_state_day_idx" ON "journal"."requirement_evaluation" USING btree ("state","journal_day_id");