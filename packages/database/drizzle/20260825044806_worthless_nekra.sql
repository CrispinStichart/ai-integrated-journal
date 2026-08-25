CREATE TYPE "public"."grounded_answer_status" AS ENUM('queued', 'running', 'succeeded', 'insufficient_support', 'failed');--> statement-breakpoint
CREATE TABLE "journal"."grounded_answer_citation" (
	"answer_id" uuid NOT NULL,
	"citation_id" text NOT NULL,
	"supplied_ordinal" integer NOT NULL,
	"cited_ordinal" integer,
	"fragment_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"layer" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"journal_date" date,
	"authority" "contribution_authority" NOT NULL,
	"retrieved_quote" text NOT NULL,
	"href" text NOT NULL,
	CONSTRAINT "grounded_answer_citation_pk" PRIMARY KEY("answer_id","citation_id"),
	CONSTRAINT "grounded_answer_citation_id_opaque" CHECK ("journal"."grounded_answer_citation"."citation_id" ~ '^cite_[0-9a-f]{32}$'),
	CONSTRAINT "grounded_answer_citation_ordinals_valid" CHECK ("journal"."grounded_answer_citation"."supplied_ordinal" between 0 and 7 and ("journal"."grounded_answer_citation"."cited_ordinal" is null or "journal"."grounded_answer_citation"."cited_ordinal" between 0 and 7)),
	CONSTRAINT "grounded_answer_citation_quote_bounded" CHECK (length("journal"."grounded_answer_citation"."retrieved_quote") between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "journal"."grounded_answer" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"question" text NOT NULL,
	"request" jsonb NOT NULL,
	"request_hash" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"retrieval" jsonb NOT NULL,
	"status" "grounded_answer_status" DEFAULT 'queued' NOT NULL,
	"job_id" uuid,
	"synthesis" text,
	"failure_code" text,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_template_hash" text NOT NULL,
	"requested_configuration" jsonb NOT NULL,
	"effective_messages_hash" text,
	"provider" jsonb,
	"model" jsonb,
	"effective_configuration" jsonb,
	"usage" jsonb,
	"processing_time_milliseconds" bigint,
	"raw_response_id" uuid,
	"raw_response_blob_key" text,
	"raw_response_media_type" text,
	"raw_response_byte_size" bigint,
	"raw_response_sha256" text,
	"raw_response_provider_request_id" text,
	"raw_response_retention" text,
	"raw_response_expires_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "grounded_answer_id_uuid_v7" CHECK (substring("journal"."grounded_answer"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "grounded_answer_question_bounded" CHECK (length(btrim("journal"."grounded_answer"."question")) between 1 and 200),
	CONSTRAINT "grounded_answer_request_hash_sha256" CHECK ("journal"."grounded_answer"."request_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grounded_answer_prompt_hash_sha256" CHECK ("journal"."grounded_answer"."prompt_template_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grounded_answer_effective_messages_hash_sha256" CHECK ("journal"."grounded_answer"."effective_messages_hash" is null or "journal"."grounded_answer"."effective_messages_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grounded_answer_raw_response_hash_sha256" CHECK ("journal"."grounded_answer"."raw_response_sha256" is null or "journal"."grounded_answer"."raw_response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "grounded_answer_terminal_consistent" CHECK (("journal"."grounded_answer"."status" in ('succeeded', 'insufficient_support', 'failed') and "journal"."grounded_answer"."completed_at" is not null) or ("journal"."grounded_answer"."status" in ('queued', 'running') and "journal"."grounded_answer"."completed_at" is null)),
	CONSTRAINT "grounded_answer_synthesis_consistent" CHECK (("journal"."grounded_answer"."status" = 'succeeded' and length(btrim("journal"."grounded_answer"."synthesis")) > 0 and "journal"."grounded_answer"."failure_code" is null) or ("journal"."grounded_answer"."status" = 'failed' and "journal"."grounded_answer"."synthesis" is null and "journal"."grounded_answer"."failure_code" is not null) or ("journal"."grounded_answer"."status" in ('queued', 'running', 'insufficient_support') and "journal"."grounded_answer"."synthesis" is null)),
	CONSTRAINT "grounded_answer_raw_response_complete" CHECK (("journal"."grounded_answer"."raw_response_id" is null and "journal"."grounded_answer"."raw_response_blob_key" is null and "journal"."grounded_answer"."raw_response_media_type" is null and "journal"."grounded_answer"."raw_response_byte_size" is null and "journal"."grounded_answer"."raw_response_sha256" is null and "journal"."grounded_answer"."raw_response_retention" is null and "journal"."grounded_answer"."raw_response_expires_at" is null) or ("journal"."grounded_answer"."raw_response_id" is not null and "journal"."grounded_answer"."raw_response_blob_key" is not null and "journal"."grounded_answer"."raw_response_media_type" is not null and "journal"."grounded_answer"."raw_response_byte_size" is not null and "journal"."grounded_answer"."raw_response_sha256" is not null and "journal"."grounded_answer"."raw_response_retention" is not null and "journal"."grounded_answer"."raw_response_expires_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD CONSTRAINT "grounded_answer_citation_answer_id_grounded_answer_id_fk" FOREIGN KEY ("answer_id") REFERENCES "journal"."grounded_answer"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer" ADD CONSTRAINT "grounded_answer_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "grounded_answer_citation_supplied_unique" ON "journal"."grounded_answer_citation" USING btree ("answer_id","supplied_ordinal");--> statement-breakpoint
CREATE UNIQUE INDEX "grounded_answer_citation_cited_unique" ON "journal"."grounded_answer_citation" USING btree ("answer_id","cited_ordinal") WHERE "journal"."grounded_answer_citation"."cited_ordinal" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "grounded_answer_owner_idempotency_unique" ON "journal"."grounded_answer" USING btree ("owner_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "grounded_answer_owner_requested_idx" ON "journal"."grounded_answer" USING btree ("owner_id","requested_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "grounded_answer_job_unique" ON "journal"."grounded_answer" USING btree ("job_id") WHERE "journal"."grounded_answer"."job_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "grounded_answer_raw_response_unique" ON "journal"."grounded_answer" USING btree ("raw_response_id") WHERE "journal"."grounded_answer"."raw_response_id" is not null;