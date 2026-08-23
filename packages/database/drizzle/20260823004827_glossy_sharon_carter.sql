CREATE TABLE "journal"."transcript_cleanup_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"source_corrected_revision_id" uuid NOT NULL,
	"output_cleaned_revision_id" uuid,
	"predecessor_run_id" uuid,
	"attempt" integer NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"status" "transcription_run_status" DEFAULT 'queued' NOT NULL,
	"input_fingerprint" text NOT NULL,
	"prompt_id" text NOT NULL,
	"prompt_version" text NOT NULL,
	"prompt_template_hash" text NOT NULL,
	"requested_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" jsonb,
	"model" jsonb,
	"effective_configuration" jsonb,
	"processing_time_milliseconds" bigint,
	"usage" jsonb,
	"raw_response_id" uuid,
	"raw_response_blob_key" text,
	"raw_response_media_type" text,
	"raw_response_byte_size" bigint,
	"raw_response_sha256" text,
	"raw_response_provider_request_id" text,
	"raw_response_retention" text,
	"raw_response_expires_at" timestamp with time zone,
	"error_code" text,
	"error_retryable" boolean,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_cleanup_run_id_uuid_v7" CHECK (substring("journal"."transcript_cleanup_run"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcript_cleanup_run_attempt_positive" CHECK ("journal"."transcript_cleanup_run"."attempt" > 0),
	CONSTRAINT "transcript_cleanup_run_execution_count_nonnegative" CHECK ("journal"."transcript_cleanup_run"."execution_count" >= 0),
	CONSTRAINT "transcript_cleanup_run_input_fingerprint_valid" CHECK ("journal"."transcript_cleanup_run"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcript_cleanup_run_prompt_hash_valid" CHECK ("journal"."transcript_cleanup_run"."prompt_template_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcript_cleanup_run_prompt_fields_not_blank" CHECK (length("journal"."transcript_cleanup_run"."prompt_id") > 0 and length("journal"."transcript_cleanup_run"."prompt_version") > 0),
	CONSTRAINT "transcript_cleanup_run_raw_response_sha256_valid" CHECK ("journal"."transcript_cleanup_run"."raw_response_sha256" is null or "journal"."transcript_cleanup_run"."raw_response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcript_cleanup_run_error_consistent" CHECK (("journal"."transcript_cleanup_run"."status" = 'failed' and "journal"."transcript_cleanup_run"."error_code" is not null and "journal"."transcript_cleanup_run"."error_retryable" is not null) or ("journal"."transcript_cleanup_run"."status" <> 'failed' and "journal"."transcript_cleanup_run"."error_code" is null and "journal"."transcript_cleanup_run"."error_retryable" is null)),
	CONSTRAINT "transcript_cleanup_run_completion_consistent" CHECK (("journal"."transcript_cleanup_run"."status" in ('succeeded', 'failed', 'canceled') and "journal"."transcript_cleanup_run"."completed_at" is not null) or ("journal"."transcript_cleanup_run"."status" in ('queued', 'running') and "journal"."transcript_cleanup_run"."completed_at" is null)),
	CONSTRAINT "transcript_cleanup_run_output_consistent" CHECK (("journal"."transcript_cleanup_run"."status" = 'succeeded' and "journal"."transcript_cleanup_run"."output_cleaned_revision_id" is not null) or ("journal"."transcript_cleanup_run"."status" <> 'succeeded' and "journal"."transcript_cleanup_run"."output_cleaned_revision_id" is null)),
	CONSTRAINT "transcript_cleanup_run_raw_response_consistent" CHECK (("journal"."transcript_cleanup_run"."raw_response_id" is null and "journal"."transcript_cleanup_run"."raw_response_blob_key" is null and "journal"."transcript_cleanup_run"."raw_response_media_type" is null and "journal"."transcript_cleanup_run"."raw_response_byte_size" is null and "journal"."transcript_cleanup_run"."raw_response_sha256" is null and "journal"."transcript_cleanup_run"."raw_response_retention" is null and "journal"."transcript_cleanup_run"."raw_response_expires_at" is null) or ("journal"."transcript_cleanup_run"."raw_response_id" is not null and "journal"."transcript_cleanup_run"."raw_response_blob_key" is not null and "journal"."transcript_cleanup_run"."raw_response_media_type" is not null and "journal"."transcript_cleanup_run"."raw_response_byte_size" is not null and "journal"."transcript_cleanup_run"."raw_response_sha256" is not null and "journal"."transcript_cleanup_run"."raw_response_retention" is not null and "journal"."transcript_cleanup_run"."raw_response_expires_at" is not null))
);
--> statement-breakpoint
DROP INDEX "journal"."transcript_revision_source_run_unique";--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ALTER COLUMN "source_run_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "source_revision_id" uuid;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "author_id" uuid;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "edit_reason" text;--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD CONSTRAINT "transcript_cleanup_run_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "journal"."recording"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD CONSTRAINT "transcript_cleanup_run_source_corrected_revision_id_transcript_revision_id_fk" FOREIGN KEY ("source_corrected_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD CONSTRAINT "transcript_cleanup_run_output_cleaned_revision_id_transcript_revision_id_fk" FOREIGN KEY ("output_cleaned_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD CONSTRAINT "transcript_cleanup_run_predecessor_run_id_fk" FOREIGN KEY ("predecessor_run_id") REFERENCES "journal"."transcript_cleanup_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_cleanup_run_revision_attempt_unique" ON "journal"."transcript_cleanup_run" USING btree ("source_corrected_revision_id","attempt");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_cleanup_run_output_revision_unique" ON "journal"."transcript_cleanup_run" USING btree ("output_cleaned_revision_id") WHERE "journal"."transcript_cleanup_run"."output_cleaned_revision_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_cleanup_run_raw_response_id_unique" ON "journal"."transcript_cleanup_run" USING btree ("raw_response_id") WHERE "journal"."transcript_cleanup_run"."raw_response_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_cleanup_run_raw_response_blob_key_unique" ON "journal"."transcript_cleanup_run" USING btree ("raw_response_blob_key") WHERE "journal"."transcript_cleanup_run"."raw_response_blob_key" is not null;--> statement-breakpoint
CREATE INDEX "transcript_cleanup_run_recording_status_idx" ON "journal"."transcript_cleanup_run" USING btree ("recording_id","status");--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_source_revision_id_fk" FOREIGN KEY ("source_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_revision_source_revision_idx" ON "journal"."transcript_revision" USING btree ("source_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revision_source_run_unique" ON "journal"."transcript_revision" USING btree ("source_run_id") WHERE "journal"."transcript_revision"."source_run_id" is not null;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_source_exactly_one" CHECK (num_nonnulls("journal"."transcript_revision"."source_run_id", "journal"."transcript_revision"."source_revision_id") = 1);--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_authority_consistent" CHECK (("journal"."transcript_revision"."authority" = 'manual' and "journal"."transcript_revision"."author_id" is not null) or ("journal"."transcript_revision"."authority" = 'generated' and "journal"."transcript_revision"."author_id" is null));