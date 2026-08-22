CREATE TYPE "public"."recording_persistence_state" AS ENUM('uploading', 'prepared', 'durable');--> statement-breakpoint
CREATE TABLE "journal"."recording_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"recording_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_api_idempotency_operation_not_blank" CHECK (length("journal"."recording_api_idempotency"."operation") > 0),
	CONSTRAINT "recording_api_idempotency_key_not_blank" CHECK (length("journal"."recording_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "recording_api_idempotency_request_hash_sha256" CHECK ("journal"."recording_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."recording_chunk" (
	"upload_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"byte_size" bigint NOT NULL,
	"sha256" text NOT NULL,
	"staging_blob_key" text NOT NULL,
	"accepted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_chunk_index_nonnegative" CHECK ("journal"."recording_chunk"."chunk_index" >= 0),
	CONSTRAINT "recording_chunk_byte_size_bounded" CHECK ("journal"."recording_chunk"."byte_size" >= 0 and "journal"."recording_chunk"."byte_size" <= 8388608),
	CONSTRAINT "recording_chunk_sha256_valid" CHECK ("journal"."recording_chunk"."sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "recording_chunk_staging_key_not_blank" CHECK (length("journal"."recording_chunk"."staging_blob_key") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."recording_upload" (
	"id" uuid PRIMARY KEY NOT NULL,
	"recording_id" uuid NOT NULL,
	"manifest_version" integer,
	"manifest_chunk_count" bigint,
	"manifest_total_bytes" bigint,
	"manifest_sha256" text,
	"manifest_fingerprint" text,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_upload_id_uuid_v7" CHECK (substring("journal"."recording_upload"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "recording_upload_manifest_counts_nonnegative" CHECK (("journal"."recording_upload"."manifest_chunk_count" is null or "journal"."recording_upload"."manifest_chunk_count" >= 0) and ("journal"."recording_upload"."manifest_total_bytes" is null or "journal"."recording_upload"."manifest_total_bytes" >= 0)),
	CONSTRAINT "recording_upload_manifest_hashes_valid" CHECK (("journal"."recording_upload"."manifest_sha256" is null or "journal"."recording_upload"."manifest_sha256" ~ '^[0-9a-f]{64}$') and ("journal"."recording_upload"."manifest_fingerprint" is null or "journal"."recording_upload"."manifest_fingerprint" ~ '^[0-9a-f]{64}$')),
	CONSTRAINT "recording_upload_manifest_fields_consistent" CHECK (("journal"."recording_upload"."manifest_version" is null and "journal"."recording_upload"."manifest_chunk_count" is null and "journal"."recording_upload"."manifest_total_bytes" is null and "journal"."recording_upload"."manifest_sha256" is null and "journal"."recording_upload"."manifest_fingerprint" is null) or ("journal"."recording_upload"."manifest_version" is not null and "journal"."recording_upload"."manifest_chunk_count" is not null and "journal"."recording_upload"."manifest_total_bytes" is not null and "journal"."recording_upload"."manifest_sha256" is not null and "journal"."recording_upload"."manifest_fingerprint" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."recording" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contribution_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"codec" text,
	"duration_milliseconds" bigint,
	"final_byte_size" bigint,
	"final_sha256" text,
	"final_blob_key" text,
	"persistence_state" "recording_persistence_state" DEFAULT 'uploading' NOT NULL,
	"audio_deleted_at" timestamp with time zone,
	"audio_deleted_by" uuid,
	"audio_restored_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "recording_id_uuid_v7" CHECK (substring("journal"."recording"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "recording_mime_type_not_blank" CHECK (length("journal"."recording"."mime_type") > 0),
	CONSTRAINT "recording_duration_nonnegative" CHECK ("journal"."recording"."duration_milliseconds" is null or "journal"."recording"."duration_milliseconds" >= 0),
	CONSTRAINT "recording_final_size_nonnegative" CHECK ("journal"."recording"."final_byte_size" is null or "journal"."recording"."final_byte_size" >= 0),
	CONSTRAINT "recording_final_sha256_valid" CHECK ("journal"."recording"."final_sha256" is null or "journal"."recording"."final_sha256" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "recording_final_fields_consistent" CHECK (("journal"."recording"."persistence_state" = 'uploading' and "journal"."recording"."final_byte_size" is null and "journal"."recording"."final_sha256" is null and "journal"."recording"."final_blob_key" is null) or ("journal"."recording"."persistence_state" in ('prepared', 'durable') and "journal"."recording"."final_byte_size" is not null and "journal"."recording"."final_sha256" is not null and "journal"."recording"."final_blob_key" is not null)),
	CONSTRAINT "recording_audio_deletion_consistent" CHECK (("journal"."recording"."audio_deleted_at" is null and "journal"."recording"."audio_deleted_by" is null) or ("journal"."recording"."audio_deleted_at" is not null and "journal"."recording"."audio_deleted_by" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."recording_api_idempotency" ADD CONSTRAINT "recording_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."recording_chunk" ADD CONSTRAINT "recording_chunk_upload_id_recording_upload_id_fk" FOREIGN KEY ("upload_id") REFERENCES "journal"."recording_upload"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."recording_upload" ADD CONSTRAINT "recording_upload_recording_id_recording_id_fk" FOREIGN KEY ("recording_id") REFERENCES "journal"."recording"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."recording" ADD CONSTRAINT "recording_contribution_id_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."recording" ADD CONSTRAINT "recording_audio_deleted_by_user_id_fk" FOREIGN KEY ("audio_deleted_by") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "recording_api_idempotency_owner_operation_key_unique" ON "journal"."recording_api_idempotency" USING btree ("owner_id","operation","idempotency_key");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_chunk_upload_index_unique" ON "journal"."recording_chunk" USING btree ("upload_id","chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_chunk_staging_blob_key_unique" ON "journal"."recording_chunk" USING btree ("staging_blob_key");--> statement-breakpoint
CREATE INDEX "recording_chunk_manifest_order_idx" ON "journal"."recording_chunk" USING btree ("upload_id","chunk_index");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_upload_recording_id_unique" ON "journal"."recording_upload" USING btree ("recording_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_contribution_id_unique" ON "journal"."recording" USING btree ("contribution_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recording_final_blob_key_unique" ON "journal"."recording" USING btree ("final_blob_key") WHERE "journal"."recording"."final_blob_key" is not null;