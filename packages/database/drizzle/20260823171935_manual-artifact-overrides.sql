CREATE TABLE "journal"."artifact_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "artifact_api_idempotency_pk" PRIMARY KEY("owner_id","operation","idempotency_key"),
	CONSTRAINT "artifact_api_idempotency_operation_not_blank" CHECK (length("journal"."artifact_api_idempotency"."operation") > 0),
	CONSTRAINT "artifact_api_idempotency_key_not_blank" CHECK (length("journal"."artifact_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "artifact_api_idempotency_hash_sha256" CHECK ("journal"."artifact_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_artifact_candidate" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_result_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"conflicts_with_manual_revision_id" uuid NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"status" text DEFAULT 'reviewable' NOT NULL,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_artifact_candidate_id_uuid_v7" CHECK (substring("journal"."processor_artifact_candidate"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_artifact_candidate_payload_hash_sha256" CHECK ("journal"."processor_artifact_candidate"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_artifact_candidate_status_valid" CHECK ("journal"."processor_artifact_candidate"."status" in ('reviewable', 'adopted', 'dismissed', 'superseded')),
	CONSTRAINT "processor_artifact_candidate_resolution_consistent" CHECK (("journal"."processor_artifact_candidate"."status" = 'reviewable' and "journal"."processor_artifact_candidate"."resolved_at" is null) or ("journal"."processor_artifact_candidate"."status" <> 'reviewable' and "journal"."processor_artifact_candidate"."resolved_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_artifact_manual_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"operation" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"overrides" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_id" uuid NOT NULL,
	"edit_group_id" uuid NOT NULL,
	"reason" text,
	"active" boolean DEFAULT true NOT NULL,
	"supersedes_revision_id" uuid,
	"superseded_by_revision_id" uuid,
	"stale_at" timestamp with time zone,
	"stale_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "processor_artifact_manual_revision_id_uuid_v7" CHECK (substring("journal"."processor_artifact_manual_revision"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_artifact_manual_revision_number_positive" CHECK ("journal"."processor_artifact_manual_revision"."revision" > 0),
	CONSTRAINT "processor_artifact_manual_operation_valid" CHECK ("journal"."processor_artifact_manual_revision"."operation" in ('confirm', 'correct', 'delete', 'merge_result', 'merge_source', 'split_result', 'split_source')),
	CONSTRAINT "processor_artifact_manual_payload_hash_sha256" CHECK ("journal"."processor_artifact_manual_revision"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_artifact_manual_lifecycle_consistent" CHECK (("journal"."processor_artifact_manual_revision"."active" = true and "journal"."processor_artifact_manual_revision"."superseded_by_revision_id" is null and "journal"."processor_artifact_manual_revision"."superseded_at" is null) or ("journal"."processor_artifact_manual_revision"."active" = false and "journal"."processor_artifact_manual_revision"."superseded_at" is not null)),
	CONSTRAINT "processor_artifact_manual_staleness_consistent" CHECK (("journal"."processor_artifact_manual_revision"."stale_at" is null and "journal"."processor_artifact_manual_revision"."stale_reason" is null) or ("journal"."processor_artifact_manual_revision"."stale_at" is not null and "journal"."processor_artifact_manual_revision"."stale_reason" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact" ADD COLUMN "revision" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."artifact_api_idempotency" ADD CONSTRAINT "artifact_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_candidate" ADD CONSTRAINT "processor_artifact_candidate_artifact_id_processor_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "journal"."processor_artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_candidate" ADD CONSTRAINT "processor_artifact_candidate_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_candidate" ADD CONSTRAINT "processor_artifact_candidate_source_result_id_processor_result_id_fk" FOREIGN KEY ("source_result_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_candidate" ADD CONSTRAINT "processor_artifact_candidate_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_candidate" ADD CONSTRAINT "processor_artifact_candidate_conflicts_with_manual_revision_id_processor_artifact_manual_revision_id_fk" FOREIGN KEY ("conflicts_with_manual_revision_id") REFERENCES "journal"."processor_artifact_manual_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_manual_revision" ADD CONSTRAINT "processor_artifact_manual_revision_artifact_id_processor_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "journal"."processor_artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_manual_revision" ADD CONSTRAINT "processor_artifact_manual_revision_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_manual_revision" ADD CONSTRAINT "processor_artifact_manual_supersedes_fk" FOREIGN KEY ("supersedes_revision_id") REFERENCES "journal"."processor_artifact_manual_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_manual_revision" ADD CONSTRAINT "processor_artifact_manual_superseded_by_fk" FOREIGN KEY ("superseded_by_revision_id") REFERENCES "journal"."processor_artifact_manual_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_candidate_run_artifact_unique" ON "journal"."processor_artifact_candidate" USING btree ("run_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_candidate_one_reviewable_unique" ON "journal"."processor_artifact_candidate" USING btree ("artifact_id") WHERE "journal"."processor_artifact_candidate"."status" = 'reviewable';--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_manual_revision_number_unique" ON "journal"."processor_artifact_manual_revision" USING btree ("artifact_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_manual_revision_one_active_unique" ON "journal"."processor_artifact_manual_revision" USING btree ("artifact_id") WHERE "journal"."processor_artifact_manual_revision"."active" = true;--> statement-breakpoint
CREATE INDEX "processor_artifact_manual_edit_group_idx" ON "journal"."processor_artifact_manual_revision" USING btree ("edit_group_id");--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact" ADD CONSTRAINT "processor_artifact_revision_nonnegative" CHECK ("journal"."processor_artifact"."revision" >= 0);