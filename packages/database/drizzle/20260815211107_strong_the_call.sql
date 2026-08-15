CREATE SCHEMA "journal";
--> statement-breakpoint
CREATE TYPE "public"."processor_requirement_mode" AS ENUM('optional', 'required');--> statement-breakpoint
CREATE TABLE "journal"."audit_event" (
	"id" uuid PRIMARY KEY NOT NULL,
	"action" text NOT NULL,
	"actor_id" uuid,
	"entity_type" text NOT NULL,
	"entity_id" uuid,
	"correlation_id" uuid NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "audit_event_action_not_blank" CHECK (length("journal"."audit_event"."action") > 0),
	CONSTRAINT "audit_event_entity_type_not_blank" CHECK (length("journal"."audit_event"."entity_type") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."development_fixture" (
	"key" text PRIMARY KEY NOT NULL,
	"fixture_type" text NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "development_fixture_key_not_blank" CHECK (length("journal"."development_fixture"."key") > 0),
	CONSTRAINT "development_fixture_type_not_blank" CHECK (length("journal"."development_fixture"."fixture_type") > 0),
	CONSTRAINT "development_fixture_payload_schema_version_positive" CHECK ("journal"."development_fixture"."payload_schema_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."processor_installation" (
	"id" uuid PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"display_name" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"requirement_mode" "processor_requirement_mode" DEFAULT 'optional' NOT NULL,
	"built_in" boolean DEFAULT true NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "processor_installation_key_not_blank" CHECK (length("journal"."processor_installation"."key") > 0),
	CONSTRAINT "processor_installation_display_name_not_blank" CHECK (length("journal"."processor_installation"."display_name") > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."queue_configuration" (
	"name" text PRIMARY KEY NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"retry_limit" integer NOT NULL,
	"retry_delay_seconds" integer NOT NULL,
	"retry_backoff" boolean NOT NULL,
	"expire_in_seconds" integer NOT NULL,
	"retention_seconds" integer NOT NULL,
	"dead_letter_queue" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "queue_configuration_name_not_blank" CHECK (length("journal"."queue_configuration"."name") > 0),
	CONSTRAINT "queue_configuration_payload_schema_version_positive" CHECK ("journal"."queue_configuration"."payload_schema_version" > 0),
	CONSTRAINT "queue_configuration_retry_limit_valid" CHECK ("journal"."queue_configuration"."retry_limit" >= 0),
	CONSTRAINT "queue_configuration_retry_delay_valid" CHECK ("journal"."queue_configuration"."retry_delay_seconds" >= 0),
	CONSTRAINT "queue_configuration_expiration_positive" CHECK ("journal"."queue_configuration"."expire_in_seconds" > 0),
	CONSTRAINT "queue_configuration_retention_valid" CHECK ("journal"."queue_configuration"."retention_seconds" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."schedule" (
	"key" text PRIMARY KEY NOT NULL,
	"queue_name" text NOT NULL,
	"cron_expression" text NOT NULL,
	"time_zone" text NOT NULL,
	"payload_schema_version" integer NOT NULL,
	"payload" jsonb NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_key_not_blank" CHECK (length("journal"."schedule"."key") > 0),
	CONSTRAINT "schedule_cron_not_blank" CHECK (length("journal"."schedule"."cron_expression") > 0),
	CONSTRAINT "schedule_time_zone_not_blank" CHECK (length("journal"."schedule"."time_zone") > 0),
	CONSTRAINT "schedule_payload_schema_version_positive" CHECK ("journal"."schedule"."payload_schema_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal"."schedule" ADD CONSTRAINT "schedule_queue_name_queue_configuration_name_fk" FOREIGN KEY ("queue_name") REFERENCES "journal"."queue_configuration"("name") ON DELETE restrict ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "audit_event_occurred_at_id_idx" ON "journal"."audit_event" USING btree ("occurred_at","id");--> statement-breakpoint
CREATE INDEX "audit_event_entity_idx" ON "journal"."audit_event" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "processor_installation_key_unique" ON "journal"."processor_installation" USING btree ("key");--> statement-breakpoint
CREATE INDEX "schedule_queue_name_idx" ON "journal"."schedule" USING btree ("queue_name");