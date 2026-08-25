CREATE TABLE "journal"."search_embedding_cohort" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"provider_display_name" text NOT NULL,
	"provider_adapter_version" text,
	"model_id" text NOT NULL,
	"model_display_name" text,
	"model_version" text DEFAULT '' NOT NULL,
	"dimension" integer NOT NULL,
	"configuration" jsonb NOT NULL,
	"configuration_fingerprint" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_embedding_cohort_dimension_bounded" CHECK ("journal"."search_embedding_cohort"."dimension" between 1 and 4096),
	CONSTRAINT "search_embedding_cohort_provider_not_blank" CHECK (length(btrim("journal"."search_embedding_cohort"."provider_id")) > 0),
	CONSTRAINT "search_embedding_cohort_model_not_blank" CHECK (length(btrim("journal"."search_embedding_cohort"."model_id")) > 0),
	CONSTRAINT "search_embedding_cohort_configuration_sha256" CHECK ("journal"."search_embedding_cohort"."configuration_fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."search_embedding_request" (
	"fragment_id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"job_id" uuid,
	"cohort_id" uuid,
	"next_chunk_index" integer DEFAULT 0 NOT NULL,
	"next_character" integer DEFAULT 1 NOT NULL,
	"last_error_code" text,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "search_embedding_request_generation_positive" CHECK ("journal"."search_embedding_request"."generation" > 0),
	CONSTRAINT "search_embedding_request_progress_valid" CHECK ("journal"."search_embedding_request"."next_chunk_index" >= 0 and "journal"."search_embedding_request"."next_character" >= 1),
	CONSTRAINT "search_embedding_request_status_valid" CHECK ("journal"."search_embedding_request"."status" in ('pending', 'dispatched', 'running', 'succeeded', 'unavailable', 'failed')),
	CONSTRAINT "search_embedding_request_job_consistent" CHECK (("journal"."search_embedding_request"."status" in ('dispatched', 'running', 'failed') and "journal"."search_embedding_request"."job_id" is not null) or ("journal"."search_embedding_request"."status" not in ('dispatched', 'running', 'failed')))
);
--> statement-breakpoint
CREATE TABLE "journal"."search_fragment_embedding" (
	"fragment_id" uuid NOT NULL,
	"cohort_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"chunk_index" integer NOT NULL,
	"start_character" integer NOT NULL,
	"end_character" integer NOT NULL,
	"embedding" vector NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_fragment_embedding_pk" PRIMARY KEY("fragment_id","cohort_id","chunk_index"),
	CONSTRAINT "search_fragment_embedding_chunk_nonnegative" CHECK ("journal"."search_fragment_embedding"."chunk_index" >= 0),
	CONSTRAINT "search_fragment_embedding_range_valid" CHECK ("journal"."search_fragment_embedding"."start_character" >= 1 and "journal"."search_fragment_embedding"."end_character" >= "journal"."search_fragment_embedding"."start_character")
);
--> statement-breakpoint
ALTER TABLE "journal"."search_embedding_cohort" ADD CONSTRAINT "search_embedding_cohort_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_embedding_request" ADD CONSTRAINT "search_embedding_request_fragment_id_search_fragment_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "journal"."search_fragment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_embedding_request" ADD CONSTRAINT "search_embedding_request_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_embedding_request" ADD CONSTRAINT "search_embedding_request_cohort_id_search_embedding_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "journal"."search_embedding_cohort"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment_embedding" ADD CONSTRAINT "search_fragment_embedding_fragment_id_search_fragment_id_fk" FOREIGN KEY ("fragment_id") REFERENCES "journal"."search_fragment"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment_embedding" ADD CONSTRAINT "search_fragment_embedding_cohort_id_search_embedding_cohort_id_fk" FOREIGN KEY ("cohort_id") REFERENCES "journal"."search_embedding_cohort"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment_embedding" ADD CONSTRAINT "search_fragment_embedding_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_embedding_cohort_identity_unique" ON "journal"."search_embedding_cohort" USING btree ("owner_id","provider_id","model_id","model_version","dimension","configuration_fingerprint");--> statement-breakpoint
CREATE INDEX "search_embedding_cohort_owner_idx" ON "journal"."search_embedding_cohort" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "search_embedding_request_dispatch_idx" ON "journal"."search_embedding_request" USING btree ("status","requested_at","fragment_id");--> statement-breakpoint
CREATE INDEX "search_fragment_embedding_owner_cohort_idx" ON "journal"."search_fragment_embedding" USING btree ("owner_id","cohort_id","fragment_id");