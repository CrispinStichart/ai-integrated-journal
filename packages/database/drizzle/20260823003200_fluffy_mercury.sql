CREATE TYPE "public"."recording_transcription_state" AS ENUM('not_started', 'queued', 'running', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."transcript_layer" AS ENUM('raw_stt', 'corrected', 'cleaned');--> statement-breakpoint
CREATE TYPE "public"."transcription_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "journal"."transcript_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript_id" uuid NOT NULL,
	"source_run_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"segments" jsonb NOT NULL,
	"language" jsonb NOT NULL,
	"timing_availability" jsonb NOT NULL,
	"authority" "contribution_authority" NOT NULL,
	"content_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_revision_id_uuid_v7" CHECK (substring("journal"."transcript_revision"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcript_revision_number_positive" CHECK ("journal"."transcript_revision"."revision" > 0),
	CONSTRAINT "transcript_revision_content_hash_sha256" CHECK ("journal"."transcript_revision"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."transcription_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"predecessor_run_id" uuid,
	"attempt" integer NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"status" "transcription_run_status" DEFAULT 'queued' NOT NULL,
	"input_audio_sha256" text NOT NULL,
	"input_fingerprint" text NOT NULL,
	"requested_context" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"effective_context" jsonb,
	"requested_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" jsonb,
	"model" jsonb,
	"effective_configuration" jsonb,
	"processing_time_milliseconds" bigint,
	"language" jsonb,
	"timing_availability" jsonb,
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
	CONSTRAINT "transcription_run_id_uuid_v7" CHECK (substring("journal"."transcription_run"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcription_run_attempt_positive" CHECK ("journal"."transcription_run"."attempt" > 0),
	CONSTRAINT "transcription_run_execution_count_nonnegative" CHECK ("journal"."transcription_run"."execution_count" >= 0),
	CONSTRAINT "transcription_run_input_audio_sha256_valid" CHECK ("journal"."transcription_run"."input_audio_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcription_run_input_fingerprint_valid" CHECK ("journal"."transcription_run"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcription_run_raw_response_sha256_valid" CHECK ("journal"."transcription_run"."raw_response_sha256" is null or "journal"."transcription_run"."raw_response_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcription_run_error_consistent" CHECK (("journal"."transcription_run"."status" = 'failed' and "journal"."transcription_run"."error_code" is not null and "journal"."transcription_run"."error_retryable" is not null) or ("journal"."transcription_run"."status" <> 'failed' and "journal"."transcription_run"."error_code" is null and "journal"."transcription_run"."error_retryable" is null)),
	CONSTRAINT "transcription_run_completion_consistent" CHECK (("journal"."transcription_run"."status" in ('succeeded', 'failed', 'canceled') and "journal"."transcription_run"."completed_at" is not null) or ("journal"."transcription_run"."status" in ('queued', 'running') and "journal"."transcription_run"."completed_at" is null)),
	CONSTRAINT "transcription_run_raw_response_consistent" CHECK (("journal"."transcription_run"."raw_response_id" is null and "journal"."transcription_run"."raw_response_blob_key" is null and "journal"."transcription_run"."raw_response_media_type" is null and "journal"."transcription_run"."raw_response_byte_size" is null and "journal"."transcription_run"."raw_response_sha256" is null and "journal"."transcription_run"."raw_response_retention" is null and "journal"."transcription_run"."raw_response_expires_at" is null) or ("journal"."transcription_run"."raw_response_id" is not null and "journal"."transcription_run"."raw_response_blob_key" is not null and "journal"."transcription_run"."raw_response_media_type" is not null and "journal"."transcription_run"."raw_response_byte_size" is not null and "journal"."transcription_run"."raw_response_sha256" is not null and "journal"."transcription_run"."raw_response_retention" is not null and "journal"."transcription_run"."raw_response_expires_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."transcript" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"layer" "transcript_layer" NOT NULL,
	"current_revision_id" uuid,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_id_uuid_v7" CHECK (substring("journal"."transcript"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcript_current_revision_consistent" CHECK (("journal"."transcript"."current_revision" = 0 and "journal"."transcript"."current_revision_id" is null) or ("journal"."transcript"."current_revision" > 0 and "journal"."transcript"."current_revision_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."recording" ADD COLUMN "transcription_state" "recording_transcription_state" DEFAULT 'not_started' NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."recording" ADD COLUMN "latest_transcription_run_id" uuid;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "journal"."transcript"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_source_run_id_transcription_run_id_fk" FOREIGN KEY ("source_run_id") REFERENCES "journal"."transcription_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcription_run" ADD CONSTRAINT "transcription_run_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "journal"."recording"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcription_run" ADD CONSTRAINT "transcription_run_predecessor_run_id_fk" FOREIGN KEY ("predecessor_run_id") REFERENCES "journal"."transcription_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript" ADD CONSTRAINT "transcript_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "journal"."recording"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revision_number_unique" ON "journal"."transcript_revision" USING btree ("transcript_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_revision_source_run_unique" ON "journal"."transcript_revision" USING btree ("source_run_id");--> statement-breakpoint
CREATE INDEX "transcript_revision_history_idx" ON "journal"."transcript_revision" USING btree ("transcript_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_run_recording_attempt_unique" ON "journal"."transcription_run" USING btree ("recording_id","attempt");--> statement-breakpoint
CREATE INDEX "transcription_run_recording_status_idx" ON "journal"."transcription_run" USING btree ("recording_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_run_raw_response_id_unique" ON "journal"."transcription_run" USING btree ("raw_response_id") WHERE "journal"."transcription_run"."raw_response_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcription_run_raw_response_blob_key_unique" ON "journal"."transcription_run" USING btree ("raw_response_blob_key") WHERE "journal"."transcription_run"."raw_response_blob_key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_recording_layer_unique" ON "journal"."transcript" USING btree ("recording_id","layer");--> statement-breakpoint
ALTER TABLE "journal"."recording" ADD CONSTRAINT "recording_transcription_state_consistent" CHECK (("journal"."recording"."transcription_state" = 'not_started' and "journal"."recording"."latest_transcription_run_id" is null) or ("journal"."recording"."transcription_state" <> 'not_started' and "journal"."recording"."latest_transcription_run_id" is not null));