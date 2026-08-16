CREATE TYPE "public"."contribution_authority" AS ENUM('manual', 'generated');--> statement-breakpoint
CREATE TYPE "public"."contribution_source_type" AS ENUM('typed_text', 'recording', 'nudge_response');--> statement-breakpoint
CREATE TYPE "public"."journal_date_assignment" AS ENUM('default', 'user_override', 'migration');--> statement-breakpoint
CREATE TABLE "journal"."contribution_revision" (
	"id" uuid PRIMARY KEY NOT NULL,
	"contribution_id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"text" text NOT NULL,
	"authority" "contribution_authority" NOT NULL,
	"author_id" uuid NOT NULL,
	"content_hash" text NOT NULL,
	"edit_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_revision_id_uuid_v7" CHECK (substring("journal"."contribution_revision"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "contribution_revision_number_positive" CHECK ("journal"."contribution_revision"."revision" > 0),
	CONSTRAINT "contribution_revision_text_not_empty" CHECK (length("journal"."contribution_revision"."text") > 0),
	CONSTRAINT "contribution_revision_content_hash_sha256" CHECK ("journal"."contribution_revision"."content_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "contribution_revision_edit_reason_not_blank" CHECK ("journal"."contribution_revision"."edit_reason" is null or length(btrim("journal"."contribution_revision"."edit_reason")) > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."contribution" (
	"id" uuid PRIMARY KEY NOT NULL,
	"journal_day_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"source_type" "contribution_source_type" NOT NULL,
	"captured_at" timestamp with time zone NOT NULL,
	"captured_timezone" text NOT NULL,
	"journal_timezone" text NOT NULL,
	"journal_date_assignment" "journal_date_assignment" NOT NULL,
	"eliciting_nudge_id" uuid,
	"current_revision_id" uuid,
	"current_revision" integer DEFAULT 0 NOT NULL,
	"deleted_at" timestamp with time zone,
	"deleted_by" uuid,
	"restored_at" timestamp with time zone,
	"restored_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "contribution_id_uuid_v7" CHECK (substring("journal"."contribution"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "contribution_current_revision_consistent" CHECK (("journal"."contribution"."current_revision" = 0 and "journal"."contribution"."current_revision_id" is null) or ("journal"."contribution"."current_revision" > 0 and "journal"."contribution"."current_revision_id" is not null)),
	CONSTRAINT "contribution_nudge_provenance" CHECK (("journal"."contribution"."source_type" = 'nudge_response' and "journal"."contribution"."eliciting_nudge_id" is not null) or ("journal"."contribution"."source_type" <> 'nudge_response' and "journal"."contribution"."eliciting_nudge_id" is null)),
	CONSTRAINT "contribution_captured_timezone_not_blank" CHECK (length("journal"."contribution"."captured_timezone") > 0),
	CONSTRAINT "contribution_journal_timezone_not_blank" CHECK (length("journal"."contribution"."journal_timezone") > 0),
	CONSTRAINT "contribution_deletion_consistent" CHECK (("journal"."contribution"."deleted_at" is null and "journal"."contribution"."deleted_by" is null) or ("journal"."contribution"."deleted_at" is not null and "journal"."contribution"."deleted_by" is not null))
);
--> statement-breakpoint
CREATE TABLE "journal"."journal_day" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"journal_date" date NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_day_id_uuid_v7" CHECK (substring("journal"."journal_day"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD COLUMN "revision_id" uuid;--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD COLUMN "before_hash" text;--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD COLUMN "after_hash" text;--> statement-breakpoint
ALTER TABLE "journal"."contribution_revision" ADD CONSTRAINT "contribution_revision_contribution_id_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution_revision" ADD CONSTRAINT "contribution_revision_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution" ADD CONSTRAINT "contribution_current_revision_id_contribution_revision_id_fk" FOREIGN KEY ("current_revision_id") REFERENCES "journal"."contribution_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution" ADD CONSTRAINT "contribution_journal_day_id_journal_day_id_fk" FOREIGN KEY ("journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution" ADD CONSTRAINT "contribution_author_id_user_id_fk" FOREIGN KEY ("author_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution" ADD CONSTRAINT "contribution_deleted_by_user_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."contribution" ADD CONSTRAINT "contribution_restored_by_user_id_fk" FOREIGN KEY ("restored_by") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."journal_day" ADD CONSTRAINT "journal_day_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "contribution_revision_number_unique" ON "journal"."contribution_revision" USING btree ("contribution_id","revision");--> statement-breakpoint
CREATE INDEX "contribution_revision_history_idx" ON "journal"."contribution_revision" USING btree ("contribution_id","revision");--> statement-breakpoint
CREATE INDEX "contribution_journal_day_created_idx" ON "journal"."contribution" USING btree ("journal_day_id","created_at","id");--> statement-breakpoint
CREATE INDEX "contribution_active_day_idx" ON "journal"."contribution" USING btree ("journal_day_id","id") WHERE "journal"."contribution"."deleted_at" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_day_user_date_unique" ON "journal"."journal_day" USING btree ("user_id","journal_date");--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD CONSTRAINT "audit_event_revision_id_uuid_v7" CHECK ("journal"."audit_event"."revision_id" is null or substring("journal"."audit_event"."revision_id"::text from 15 for 1) = '7');--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD CONSTRAINT "audit_event_before_hash_sha256" CHECK ("journal"."audit_event"."before_hash" is null or "journal"."audit_event"."before_hash" ~ '^[0-9a-f]{64}$');--> statement-breakpoint
ALTER TABLE "journal"."audit_event" ADD CONSTRAINT "audit_event_after_hash_sha256" CHECK ("journal"."audit_event"."after_hash" is null or "journal"."audit_event"."after_hash" ~ '^[0-9a-f]{64}$');
