CREATE TABLE "journal"."processor_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"processor_id" uuid NOT NULL,
	"response" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_api_idempotency_pk" PRIMARY KEY("owner_id","operation","idempotency_key"),
	CONSTRAINT "processor_api_idempotency_operation_not_blank" CHECK (length("journal"."processor_api_idempotency"."operation") > 0),
	CONSTRAINT "processor_api_idempotency_key_not_blank" CHECK (length("journal"."processor_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "processor_api_idempotency_hash_sha256" CHECK ("journal"."processor_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_version_dependency" (
	"processor_version_id" uuid NOT NULL,
	"upstream_version_id" uuid NOT NULL,
	"output_selector" text NOT NULL,
	"accept_partial" boolean DEFAULT false NOT NULL,
	CONSTRAINT "processor_version_dependency_pk" PRIMARY KEY("processor_version_id","upstream_version_id","output_selector"),
	CONSTRAINT "processor_version_dependency_not_self" CHECK ("journal"."processor_version_dependency"."processor_version_id" <> "journal"."processor_version_dependency"."upstream_version_id"),
	CONSTRAINT "processor_version_dependency_selector_not_blank" CHECK (length("journal"."processor_version_dependency"."output_selector") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_version" (
	"id" uuid PRIMARY KEY NOT NULL,
	"processor_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"semantic_version" text NOT NULL,
	"definition" jsonb NOT NULL,
	"instruction_hash" text NOT NULL,
	"output_schema_hash" text NOT NULL,
	"prompt_template_hash" text NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_version_id_uuid_v7" CHECK (substring("journal"."processor_version"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "processor_version_revision_positive" CHECK ("journal"."processor_version"."revision" > 0),
	CONSTRAINT "processor_version_semantic_valid" CHECK ("journal"."processor_version"."semantic_version" ~ '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'),
	CONSTRAINT "processor_version_instruction_hash_sha256" CHECK ("journal"."processor_version"."instruction_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_version_output_schema_hash_sha256" CHECK ("journal"."processor_version"."output_schema_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "processor_version_prompt_template_hash_sha256" CHECK ("journal"."processor_version"."prompt_template_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "journal"."processor_installation" ADD COLUMN "purpose" text DEFAULT 'Journal processor' NOT NULL;--> statement-breakpoint
UPDATE "journal"."processor_installation"
SET "purpose" = CASE "key"
	WHEN 'food-and-drink' THEN 'Extract user food and drink consumption observations.'
	WHEN 'mood' THEN 'Extract contextual mood observations and interpretations.'
	WHEN 'sleep' THEN 'Extract sleep periods using the wake-date convention.'
	WHEN 'tasks-and-intentions' THEN 'Distinguish tasks, intentions, ideas, and completed actions.'
	WHEN 'summary' THEN 'Produce a grounded daily narrative summary.'
	WHEN 'accomplishments' THEN 'Produce grounded notable-event and accomplishment bullets.'
	ELSE "purpose"
END;--> statement-breakpoint
ALTER TABLE "journal"."processor_installation" ADD COLUMN "config_revision" integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."processor_installation" ADD COLUMN "current_version_id" uuid;--> statement-breakpoint
ALTER TABLE "journal"."processor_api_idempotency" ADD CONSTRAINT "processor_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_api_idempotency" ADD CONSTRAINT "processor_api_idempotency_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_version_dependency" ADD CONSTRAINT "processor_version_dependency_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_version_dependency" ADD CONSTRAINT "processor_version_dependency_upstream_version_id_processor_version_id_fk" FOREIGN KEY ("upstream_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_version" ADD CONSTRAINT "processor_version_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."processor_version" ADD CONSTRAINT "processor_version_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "processor_version_dependency_upstream_idx" ON "journal"."processor_version_dependency" USING btree ("upstream_version_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_version_revision_unique" ON "journal"."processor_version" USING btree ("processor_id","revision");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_version_semantic_unique" ON "journal"."processor_version" USING btree ("processor_id","semantic_version");--> statement-breakpoint
CREATE INDEX "processor_version_processor_created_idx" ON "journal"."processor_version" USING btree ("processor_id","created_at","id");--> statement-breakpoint
ALTER TABLE "journal"."processor_installation" ADD CONSTRAINT "processor_installation_purpose_not_blank" CHECK (length("journal"."processor_installation"."purpose") > 0);--> statement-breakpoint
ALTER TABLE "journal"."processor_installation" ADD CONSTRAINT "processor_installation_config_revision_positive" CHECK ("journal"."processor_installation"."config_revision" > 0);
