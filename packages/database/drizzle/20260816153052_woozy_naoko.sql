CREATE TYPE "public"."auth_challenge_purpose" AS ENUM('passkey_registration', 'passkey_authentication');--> statement-breakpoint
CREATE TABLE "journal"."auth_challenge" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid,
	"purpose" "auth_challenge_purpose" NOT NULL,
	"challenge_hash" text NOT NULL,
	"challenge" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_challenge_id_uuid_v7" CHECK (substring("journal"."auth_challenge"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "journal"."authenticator" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" text[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	CONSTRAINT "authenticator_id_uuid_v7" CHECK (substring("journal"."authenticator"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "authenticator_counter_valid" CHECK ("journal"."authenticator"."counter" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."password_credential" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "journal"."recovery_code" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"code_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"used_at" timestamp with time zone,
	CONSTRAINT "recovery_code_id_uuid_v7" CHECK (substring("journal"."recovery_code"."id"::text from 15 for 1) = '7')
);
--> statement-breakpoint
CREATE TABLE "journal"."session" (
	"id" uuid PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"csrf_token_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	"idle_expires_at" timestamp with time zone NOT NULL,
	"absolute_expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "session_id_uuid_v7" CHECK (substring("journal"."session"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "session_idle_before_absolute" CHECK ("journal"."session"."idle_expires_at" <= "journal"."session"."absolute_expires_at")
);
--> statement-breakpoint
CREATE TABLE "journal"."user" (
	"id" uuid PRIMARY KEY NOT NULL,
	"singleton" boolean DEFAULT true NOT NULL,
	"display_name" text NOT NULL,
	"locale" text DEFAULT 'en' NOT NULL,
	"journal_time_zone" text DEFAULT 'UTC' NOT NULL,
	"preferences_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_singleton_true" CHECK ("journal"."user"."singleton" = true),
	CONSTRAINT "user_id_uuid_v7" CHECK (substring("journal"."user"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "user_display_name_not_blank" CHECK (length("journal"."user"."display_name") > 0),
	CONSTRAINT "user_preferences_version_positive" CHECK ("journal"."user"."preferences_version" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal"."auth_challenge" ADD CONSTRAINT "auth_challenge_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."authenticator" ADD CONSTRAINT "authenticator_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."password_credential" ADD CONSTRAINT "password_credential_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."recovery_code" ADD CONSTRAINT "recovery_code_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_challenge_hash_unique" ON "journal"."auth_challenge" USING btree ("challenge_hash");--> statement-breakpoint
CREATE INDEX "auth_challenge_expiry_idx" ON "journal"."auth_challenge" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "authenticator_credential_id_unique" ON "journal"."authenticator" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "authenticator_user_id_idx" ON "journal"."authenticator" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_code_hash_unique" ON "journal"."recovery_code" USING btree ("code_hash");--> statement-breakpoint
CREATE INDEX "recovery_code_user_id_idx" ON "journal"."recovery_code" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "session_token_hash_unique" ON "journal"."session" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "session_user_id_idx" ON "journal"."session" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "session_expiry_idx" ON "journal"."session" USING btree ("absolute_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "user_singleton_unique" ON "journal"."user" USING btree ("singleton");