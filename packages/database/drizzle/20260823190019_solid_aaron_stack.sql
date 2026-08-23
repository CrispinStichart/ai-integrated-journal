CREATE TYPE "public"."feedback_target_kind" AS ENUM('transcript_revision', 'artifact_version', 'processor_result');--> statement-breakpoint
CREATE TYPE "public"."memory_approval_state" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."memory_creator" AS ENUM('user', 'ai');--> statement-breakpoint
CREATE TYPE "public"."memory_type" AS ENUM('transcription_context', 'known_entity', 'alias', 'correction_rule', 'processor_rule', 'known_fact', 'application_preference');--> statement-breakpoint
CREATE TABLE "journal"."feedback" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"target_kind" "feedback_target_kind" NOT NULL,
	"target_id" uuid NOT NULL,
	"message" text NOT NULL,
	"classified_scope" jsonb NOT NULL,
	"resulting_memory_id" uuid,
	"actor_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_id_uuid_v7" CHECK (substring("journal"."feedback"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "feedback_message_not_blank" CHECK (length(btrim("journal"."feedback"."message")) > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."memory" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"current_revision_id" uuid NOT NULL,
	"current_revision" integer NOT NULL,
	"approval_state" "memory_approval_state" NOT NULL,
	"enabled" boolean NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_id_uuid_v7" CHECK (substring("journal"."memory"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "memory_current_revision_positive" CHECK ("journal"."memory"."current_revision" > 0),
	CONSTRAINT "memory_activation_consistent" CHECK ("journal"."memory"."enabled" = false or ("journal"."memory"."approval_state" = 'approved' and "journal"."memory"."deleted_at" is null))
);
--> statement-breakpoint
CREATE TABLE "journal"."memory_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"feedback_id" uuid,
	"memory_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_api_idempotency_operation_not_blank" CHECK (length("journal"."memory_api_idempotency"."operation") > 0),
	CONSTRAINT "memory_api_idempotency_key_not_blank" CHECK (length("journal"."memory_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "memory_api_idempotency_request_hash_sha256" CHECK ("journal"."memory_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "memory_api_idempotency_result_present" CHECK (num_nonnulls("journal"."memory_api_idempotency"."feedback_id", "journal"."memory_api_idempotency"."memory_id") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."memory_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"memory_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"type" "memory_type" NOT NULL,
	"content" text NOT NULL,
	"rationale" text NOT NULL,
	"creator" "memory_creator" NOT NULL,
	"approval_state" "memory_approval_state" NOT NULL,
	"scope" jsonb NOT NULL,
	"enabled" boolean NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memory_revision_id_uuid_v7" CHECK (substring("journal"."memory_revision"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "memory_revision_positive" CHECK ("journal"."memory_revision"."revision" > 0),
	CONSTRAINT "memory_revision_content_not_blank" CHECK (length(btrim("journal"."memory_revision"."content")) > 0),
	CONSTRAINT "memory_revision_rationale_not_blank" CHECK (length(btrim("journal"."memory_revision"."rationale")) > 0),
	CONSTRAINT "memory_revision_activation_consistent" CHECK ("journal"."memory_revision"."enabled" = false or ("journal"."memory_revision"."approval_state" = 'approved' and "journal"."memory_revision"."deleted_at" is null))
);
--> statement-breakpoint
ALTER TABLE "journal"."feedback" ADD CONSTRAINT "feedback_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."feedback" ADD CONSTRAINT "feedback_resulting_memory_id_memory_id_fk" FOREIGN KEY ("resulting_memory_id") REFERENCES "journal"."memory"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."feedback" ADD CONSTRAINT "feedback_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."memory" ADD CONSTRAINT "memory_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."memory_api_idempotency" ADD CONSTRAINT "memory_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."memory_api_idempotency" ADD CONSTRAINT "memory_api_idempotency_feedback_id_feedback_id_fk" FOREIGN KEY ("feedback_id") REFERENCES "journal"."feedback"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."memory_api_idempotency" ADD CONSTRAINT "memory_api_idempotency_memory_id_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "journal"."memory"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."memory_revision" ADD CONSTRAINT "memory_revision_memory_id_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "journal"."memory"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "feedback_owner_target_idx" ON "journal"."feedback" USING btree ("owner_id","target_kind","target_id");--> statement-breakpoint
CREATE INDEX "memory_owner_current_idx" ON "journal"."memory" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "memory_owner_active_idx" ON "journal"."memory" USING btree ("owner_id","enabled","id") WHERE "journal"."memory"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "memory_current_revision_id_unique" ON "journal"."memory" USING btree ("current_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_api_idempotency_owner_operation_key_unique" ON "journal"."memory_api_idempotency" USING btree ("owner_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "memory_revision_number_unique" ON "journal"."memory_revision" USING btree ("memory_id","revision");--> statement-breakpoint
CREATE INDEX "memory_revision_history_idx" ON "journal"."memory_revision" USING btree ("memory_id","revision");