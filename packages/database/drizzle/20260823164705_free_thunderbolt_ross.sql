CREATE TABLE "journal"."processor_artifact_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"artifact_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"source_result_id" uuid NOT NULL,
	"processor_version_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_hash" text NOT NULL,
	"lifecycle" text DEFAULT 'active' NOT NULL,
	"reconciliation_outcome" text NOT NULL,
	"supersedes_version_id" uuid,
	"superseded_by_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"superseded_at" timestamp with time zone,
	CONSTRAINT "processor_artifact_version_id_uuid_v7" CHECK (substring("journal"."processor_artifact_version"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_artifact_version_revision_positive" CHECK ("journal"."processor_artifact_version"."revision" > 0),
	CONSTRAINT "processor_artifact_version_payload_hash_sha256" CHECK ("journal"."processor_artifact_version"."payload_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_artifact_version_lifecycle_valid" CHECK ("journal"."processor_artifact_version"."lifecycle" in ('active', 'superseded')),
	CONSTRAINT "processor_artifact_version_outcome_valid" CHECK ("journal"."processor_artifact_version"."reconciliation_outcome" in ('create', 'update', 'supersede')),
	CONSTRAINT "processor_artifact_version_supersession_consistent" CHECK (("journal"."processor_artifact_version"."lifecycle" = 'active' and "journal"."processor_artifact_version"."superseded_by_version_id" is null and "journal"."processor_artifact_version"."superseded_at" is null) or ("journal"."processor_artifact_version"."lifecycle" = 'superseded' and "journal"."processor_artifact_version"."superseded_at" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_artifact" (
	"id" uuid PRIMARY KEY NOT NULL,
	"processor_id" uuid NOT NULL,
	"target_journal_day_id" uuid NOT NULL,
	"target_contribution_id" uuid,
	"logical_key" text NOT NULL,
	"kind" text NOT NULL,
	"authority" "contribution_authority" DEFAULT 'generated' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_artifact_id_uuid_v7" CHECK (substring("journal"."processor_artifact"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_artifact_logical_key_valid" CHECK (length("journal"."processor_artifact"."logical_key") > 0 and length("journal"."processor_artifact"."logical_key") <= 256),
	CONSTRAINT "processor_artifact_kind_valid" CHECK ("journal"."processor_artifact"."kind" in ('source_transform', 'observation', 'interpretation', 'other'))
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_reconciliation_outcome" (
	"run_id" uuid NOT NULL,
	"ordinal" integer NOT NULL,
	"logical_key" text NOT NULL,
	"outcome" text NOT NULL,
	"artifact_id" uuid,
	"version_id" uuid,
	"prior_version_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_reconciliation_outcome_pk" PRIMARY KEY("run_id","ordinal"),
	CONSTRAINT "processor_reconciliation_outcome_ordinal_nonnegative" CHECK ("journal"."processor_reconciliation_outcome"."ordinal" >= 0),
	CONSTRAINT "processor_reconciliation_outcome_key_valid" CHECK (length("journal"."processor_reconciliation_outcome"."logical_key") > 0 and length("journal"."processor_reconciliation_outcome"."logical_key") <= 256),
	CONSTRAINT "processor_reconciliation_outcome_value_valid" CHECK ("journal"."processor_reconciliation_outcome"."outcome" in ('create', 'update', 'supersede', 'remove_supersede', 'unchanged')),
	CONSTRAINT "processor_reconciliation_outcome_references_consistent" CHECK (("journal"."processor_reconciliation_outcome"."outcome" = 'create' and "journal"."processor_reconciliation_outcome"."artifact_id" is not null and "journal"."processor_reconciliation_outcome"."version_id" is not null and "journal"."processor_reconciliation_outcome"."prior_version_id" is null) or ("journal"."processor_reconciliation_outcome"."outcome" in ('update', 'supersede') and "journal"."processor_reconciliation_outcome"."artifact_id" is not null and "journal"."processor_reconciliation_outcome"."version_id" is not null and "journal"."processor_reconciliation_outcome"."prior_version_id" is not null) or ("journal"."processor_reconciliation_outcome"."outcome" in ('remove_supersede', 'unchanged') and "journal"."processor_reconciliation_outcome"."artifact_id" is not null and "journal"."processor_reconciliation_outcome"."version_id" is null and "journal"."processor_reconciliation_outcome"."prior_version_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_reconciliation" (
	"run_id" uuid PRIMARY KEY NOT NULL,
	"source_result_id" uuid NOT NULL,
	"strategy" text NOT NULL,
	"completeness" "processor_completeness" NOT NULL,
	"input_hash" text NOT NULL,
	"completed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_reconciliation_strategy_valid" CHECK ("journal"."processor_reconciliation"."strategy" in ('replace_scope', 'logical_key', 'append_only')),
	CONSTRAINT "processor_reconciliation_input_hash_sha256" CHECK ("journal"."processor_reconciliation"."input_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_artifact_id_processor_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "journal"."processor_artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_source_result_id_processor_result_id_fk" FOREIGN KEY ("source_result_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_supersedes_fk" FOREIGN KEY ("supersedes_version_id") REFERENCES "journal"."processor_artifact_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact_version" ADD CONSTRAINT "processor_artifact_version_superseded_by_fk" FOREIGN KEY ("superseded_by_version_id") REFERENCES "journal"."processor_artifact_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact" ADD CONSTRAINT "processor_artifact_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact" ADD CONSTRAINT "processor_artifact_target_journal_day_id_journal_day_id_fk" FOREIGN KEY ("target_journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_artifact" ADD CONSTRAINT "processor_artifact_target_contribution_id_contribution_id_fk" FOREIGN KEY ("target_contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation_outcome" ADD CONSTRAINT "processor_reconciliation_outcome_run_id_processor_reconciliation_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_reconciliation"("run_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation_outcome" ADD CONSTRAINT "processor_reconciliation_outcome_artifact_id_processor_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "journal"."processor_artifact"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation_outcome" ADD CONSTRAINT "processor_reconciliation_outcome_version_id_processor_artifact_version_id_fk" FOREIGN KEY ("version_id") REFERENCES "journal"."processor_artifact_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation_outcome" ADD CONSTRAINT "processor_reconciliation_outcome_prior_version_id_processor_artifact_version_id_fk" FOREIGN KEY ("prior_version_id") REFERENCES "journal"."processor_artifact_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation" ADD CONSTRAINT "processor_reconciliation_run_id_processor_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "journal"."processor_run"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_reconciliation" ADD CONSTRAINT "processor_reconciliation_source_result_id_processor_result_id_fk" FOREIGN KEY ("source_result_id") REFERENCES "journal"."processor_result"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_version_revision_unique" ON "journal"."processor_artifact_version" USING btree ("artifact_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_version_run_artifact_unique" ON "journal"."processor_artifact_version" USING btree ("run_id","artifact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_version_one_active_unique" ON "journal"."processor_artifact_version" USING btree ("artifact_id") WHERE "journal"."processor_artifact_version"."lifecycle" = 'active';--> statement-breakpoint
CREATE INDEX "processor_artifact_version_source_result_idx" ON "journal"."processor_artifact_version" USING btree ("source_result_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_day_logical_key_unique" ON "journal"."processor_artifact" USING btree ("processor_id","target_journal_day_id","logical_key") WHERE "journal"."processor_artifact"."target_contribution_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "processor_artifact_contribution_logical_key_unique" ON "journal"."processor_artifact" USING btree ("processor_id","target_contribution_id","logical_key") WHERE "journal"."processor_artifact"."target_contribution_id" is not null;--> statement-breakpoint
CREATE INDEX "processor_artifact_active_target_idx" ON "journal"."processor_artifact" USING btree ("target_journal_day_id","processor_id","active");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_reconciliation_outcome_run_key_unique" ON "journal"."processor_reconciliation_outcome" USING btree ("run_id","logical_key");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_reconciliation_source_result_unique" ON "journal"."processor_reconciliation" USING btree ("source_result_id");