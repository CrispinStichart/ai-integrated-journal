CREATE TABLE "journal"."reprocessing_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"batch_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reprocessing_api_idempotency_pk" PRIMARY KEY("owner_id","operation","idempotency_key"),
	CONSTRAINT "reprocessing_api_idempotency_operation_not_blank" CHECK (length("journal"."reprocessing_api_idempotency"."operation") > 0),
	CONSTRAINT "reprocessing_api_idempotency_key_not_blank" CHECK (length("journal"."reprocessing_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "reprocessing_api_idempotency_hash_sha256" CHECK ("journal"."reprocessing_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."reprocessing_batch_item" (
	"batch_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"run_id" uuid NOT NULL,
	"processor_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"journal_day_id" uuid NOT NULL,
	"contribution_id" uuid,
	"provider_operation_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reprocessing_batch_item_pk" PRIMARY KEY("batch_id","ordinal"),
	CONSTRAINT "reprocessing_batch_item_ordinal_nonnegative" CHECK ("journal"."reprocessing_batch_item"."ordinal" >= 0),
	CONSTRAINT "reprocessing_batch_item_provider_count_nonnegative" CHECK ("journal"."reprocessing_batch_item"."provider_operation_count" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."reprocessing_batch" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"revision" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"target" jsonb NOT NULL,
	"version_basis" jsonb NOT NULL,
	"impact" jsonb NOT NULL,
	"impact_fingerprint" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"cancel_requested_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reprocessing_batch_id_uuid_v7" CHECK (substring("journal"."reprocessing_batch"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "reprocessing_batch_revision_positive" CHECK ("journal"."reprocessing_batch"."revision" > 0),
	CONSTRAINT "reprocessing_batch_state_valid" CHECK ("journal"."reprocessing_batch"."state" in ('active', 'canceled')),
	CONSTRAINT "reprocessing_batch_impact_hash_sha256" CHECK ("journal"."reprocessing_batch"."impact_fingerprint" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "reprocessing_batch_cancel_consistent" CHECK (("journal"."reprocessing_batch"."state" = 'active' and "journal"."reprocessing_batch"."cancel_requested_at" is null) or ("journal"."reprocessing_batch"."state" = 'canceled' and "journal"."reprocessing_batch"."cancel_requested_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_api_idempotency" ADD CONSTRAINT "reprocessing_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_api_idempotency" ADD CONSTRAINT "reprocessing_api_idempotency_batch_id_reprocessing_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "journal"."reprocessing_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_batch_id_reprocessing_batch_id_fk" FOREIGN KEY ("batch_id") REFERENCES "journal"."reprocessing_batch"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_journal_day_id_journal_day_id_fk" FOREIGN KEY ("journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch_item" ADD CONSTRAINT "reprocessing_batch_item_contribution_id_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."reprocessing_batch" ADD CONSTRAINT "reprocessing_batch_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "reprocessing_batch_item_run_unique" ON "journal"."reprocessing_batch_item" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "reprocessing_batch_item_version_target_idx" ON "journal"."reprocessing_batch_item" USING btree ("processor_version_id","journal_day_id");--> statement-breakpoint
CREATE INDEX "reprocessing_batch_owner_created_idx" ON "journal"."reprocessing_batch" USING btree ("owner_id","created_at","id");