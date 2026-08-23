CREATE TYPE "public"."processor_completeness" AS ENUM('complete', 'partial');--> statement-breakpoint
CREATE TYPE "public"."processor_input_kind" AS ENUM('typed_text', 'corrected_transcript', 'cleaned_transcript', 'processor_result');--> statement-breakpoint
CREATE TYPE "public"."processor_run_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'canceled');--> statement-breakpoint
CREATE TABLE "journal"."processor_result_evidence" (
	"id" uuid PRIMARY KEY NOT NULL,
	"processor_result_id" uuid NOT NULL,
	"source_label" text NOT NULL,
	"contribution_revision_id" uuid,
	"transcript_revision_id" uuid,
	"normalization" text NOT NULL,
	"offset_unit" text NOT NULL,
	"start_utf16" integer NOT NULL,
	"end_utf16" integer NOT NULL,
	"start_ms" bigint,
	"end_ms" bigint,
	"quote" text NOT NULL,
	"quote_hash" text NOT NULL,
	"resolution_status" "evidence_resolution_status" DEFAULT 'resolved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_result_evidence_id_uuid_v7" CHECK (substring("journal"."processor_result_evidence"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_result_evidence_exactly_one_source" CHECK (num_nonnulls("journal"."processor_result_evidence"."contribution_revision_id", "journal"."processor_result_evidence"."transcript_revision_id") = 1),
	CONSTRAINT "processor_result_evidence_coordinate_contract" CHECK ("journal"."processor_result_evidence"."normalization" = 'NFC_LF_V1' and "journal"."processor_result_evidence"."offset_unit" = 'utf16_code_unit'),
	CONSTRAINT "processor_result_evidence_text_range_valid" CHECK ("journal"."processor_result_evidence"."start_utf16" >= 0 and "journal"."processor_result_evidence"."start_utf16" < "journal"."processor_result_evidence"."end_utf16"),
	CONSTRAINT "processor_result_evidence_audio_range_valid" CHECK (("journal"."processor_result_evidence"."start_ms" is null and "journal"."processor_result_evidence"."end_ms" is null) or ("journal"."processor_result_evidence"."start_ms" >= 0 and "journal"."processor_result_evidence"."start_ms" < "journal"."processor_result_evidence"."end_ms")),
	CONSTRAINT "processor_result_evidence_quote_hash_sha256" CHECK ("journal"."processor_result_evidence"."quote_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_result" (
	"id" uuid PRIMARY KEY NOT NULL,
	"run_id" uuid NOT NULL,
	"processor_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"target_journal_day_id" uuid NOT NULL,
	"target_contribution_id" uuid,
	"kind" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"completeness" "processor_completeness" NOT NULL,
	"payload" jsonb NOT NULL,
	"authority" "contribution_authority" DEFAULT 'generated' NOT NULL,
	"manually_modified" boolean DEFAULT false NOT NULL,
	"stale_at" timestamp with time zone,
	"stale_reason" text,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_result_id_uuid_v7" CHECK (substring("journal"."processor_result"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_result_kind_valid" CHECK ("journal"."processor_result"."kind" in ('source_transform', 'observation', 'interpretation', 'other')),
	CONSTRAINT "processor_result_lifecycle_valid" CHECK ("journal"."processor_result"."lifecycle" in ('active', 'superseded')),
	CONSTRAINT "processor_result_generated_only" CHECK ("journal"."processor_result"."authority" = 'generated' and "journal"."processor_result"."manually_modified" = false),
	CONSTRAINT "processor_result_staleness_consistent" CHECK (("journal"."processor_result"."stale_at" is null and "journal"."processor_result"."stale_reason" is null) or ("journal"."processor_result"."stale_at" is not null and "journal"."processor_result"."stale_reason" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_run_input" (
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"label" text NOT NULL,
	"input_kind" "processor_input_kind" NOT NULL,
	"contribution_revision_id" uuid,
	"transcript_revision_id" uuid,
	"processor_result_id" uuid,
	"included_start_utf16" integer DEFAULT 0 NOT NULL,
	"included_end_utf16" integer NOT NULL,
	"full_length_utf16" integer NOT NULL,
	"content_hash" text NOT NULL,
	"temporal_context" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_run_input_pk" PRIMARY KEY("run_id","ordinal"),
	CONSTRAINT "processor_run_input_ordinal_nonnegative" CHECK ("journal"."processor_run_input"."ordinal" >= 0),
	CONSTRAINT "processor_run_input_exactly_one_source" CHECK (num_nonnulls("journal"."processor_run_input"."contribution_revision_id", "journal"."processor_run_input"."transcript_revision_id", "journal"."processor_run_input"."processor_result_id") = 1),
	CONSTRAINT "processor_run_input_range_valid" CHECK ("journal"."processor_run_input"."included_start_utf16" = 0 and "journal"."processor_run_input"."included_end_utf16" >= 0 and "journal"."processor_run_input"."included_end_utf16" <= "journal"."processor_run_input"."full_length_utf16"),
	CONSTRAINT "processor_run_input_content_hash_sha256" CHECK ("journal"."processor_run_input"."content_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_run" (
	"id" uuid PRIMARY KEY NOT NULL,
	"processor_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"target_scope" text NOT NULL,
	"target_journal_day_id" uuid,
	"target_contribution_id" uuid,
	"predecessor_run_id" uuid,
	"attempt" integer NOT NULL,
	"execution_count" integer DEFAULT 0 NOT NULL,
	"status" "processor_run_status" DEFAULT 'queued' NOT NULL,
	"input_completeness" "processor_completeness" NOT NULL,
	"input_fingerprint" text NOT NULL,
	"prompt_assembly_version" text NOT NULL,
	"prompt_template_hash" text NOT NULL,
	"requested_configuration" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"provider" jsonb,
	"model" jsonb,
	"effective_configuration" jsonb,
	"effective_messages_hash" text,
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
	"output_result_id" uuid,
	"error_code" text,
	"error_retryable" boolean,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_run_id_uuid_v7" CHECK (substring("journal"."processor_run"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_run_attempt_positive" CHECK ("journal"."processor_run"."attempt" > 0),
	CONSTRAINT "processor_run_execution_nonnegative" CHECK ("journal"."processor_run"."execution_count" >= 0),
	CONSTRAINT "processor_run_scope_valid" CHECK ("journal"."processor_run"."target_scope" in ('contribution', 'journal_day')),
	CONSTRAINT "processor_run_target_consistent" CHECK (("journal"."processor_run"."target_scope" = 'journal_day' and "journal"."processor_run"."target_journal_day_id" is not null and "journal"."processor_run"."target_contribution_id" is null) or ("journal"."processor_run"."target_scope" = 'contribution' and "journal"."processor_run"."target_journal_day_id" is not null and "journal"."processor_run"."target_contribution_id" is not null)),
	CONSTRAINT "processor_run_input_hash_sha256" CHECK ("journal"."processor_run"."input_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_run_prompt_hash_sha256" CHECK ("journal"."processor_run"."prompt_template_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_run_effective_messages_hash_sha256" CHECK ("journal"."processor_run"."effective_messages_hash" is null or "journal"."processor_run"."effective_messages_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_run_error_consistent" CHECK (("journal"."processor_run"."status" = 'failed' and "journal"."processor_run"."error_code" is not null and "journal"."processor_run"."error_retryable" is not null) or ("journal"."processor_run"."status" <> 'failed' and "journal"."processor_run"."error_code" is null and "journal"."processor_run"."error_retryable" is null)),
	CONSTRAINT "processor_run_completion_consistent" CHECK (("journal"."processor_run"."status" in ('succeeded', 'failed', 'canceled') and "journal"."processor_run"."completed_at" is not null) or ("journal"."processor_run"."status" in ('queued', 'running') and "journal"."processor_run"."completed_at" is null)),
	CONSTRAINT "processor_run_output_consistent" CHECK (("journal"."processor_run"."status" = 'succeeded' and "journal"."processor_run"."output_result_id" is not null) or ("journal"."processor_run"."status" <> 'succeeded' and "journal"."processor_run"."output_result_id" is null))
);
--> statement-breakpoint
ALTER TABLE "journal"."processor_result_evidence" ADD CONSTRAINT "processor_result_evidence_processor_result_id_processor_result_id_fk" FOREIGN KEY ("processor_result_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result_evidence" ADD CONSTRAINT "processor_result_evidence_contribution_revision_id_contribution_revision_id_fk" FOREIGN KEY ("contribution_revision_id") REFERENCES "journal"."contribution_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result_evidence" ADD CONSTRAINT "processor_result_evidence_transcript_revision_id_transcript_revision_id_fk" FOREIGN KEY ("transcript_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_target_journal_day_id_journal_day_id_fk" FOREIGN KEY ("target_journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_target_contribution_id_contribution_id_fk" FOREIGN KEY ("target_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_result" ADD CONSTRAINT "processor_result_superseded_by_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run_input" ADD CONSTRAINT "processor_run_input_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run_input" ADD CONSTRAINT "processor_run_input_contribution_revision_id_contribution_revision_id_fk" FOREIGN KEY ("contribution_revision_id") REFERENCES "journal"."contribution_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run_input" ADD CONSTRAINT "processor_run_input_transcript_revision_id_transcript_revision_id_fk" FOREIGN KEY ("transcript_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run_input" ADD CONSTRAINT "processor_run_input_processor_result_id_processor_result_id_fk" FOREIGN KEY ("processor_result_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run" ADD CONSTRAINT "processor_run_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run" ADD CONSTRAINT "processor_run_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run" ADD CONSTRAINT "processor_run_target_journal_day_id_journal_day_id_fk" FOREIGN KEY ("target_journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run" ADD CONSTRAINT "processor_run_target_contribution_id_contribution_id_fk" FOREIGN KEY ("target_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_run" ADD CONSTRAINT "processor_run_predecessor_fk" FOREIGN KEY ("predecessor_run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processor_result_evidence_result_idx" ON "journal"."processor_result_evidence" USING btree ("processor_result_id");--> statement-breakpoint
CREATE INDEX "processor_result_evidence_transcript_idx" ON "journal"."processor_result_evidence" USING btree ("transcript_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_result_run_unique" ON "journal"."processor_result" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "processor_result_target_idx" ON "journal"."processor_result" USING btree ("target_journal_day_id","processor_version_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_run_input_label_unique" ON "journal"."processor_run_input" USING btree ("run_id","label");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_run_target_attempt_unique" ON "journal"."processor_run" USING btree ("processor_version_id","target_scope","target_journal_day_id","target_contribution_id","attempt");--> statement-breakpoint
CREATE INDEX "processor_run_target_status_idx" ON "journal"."processor_run" USING btree ("target_journal_day_id","status");