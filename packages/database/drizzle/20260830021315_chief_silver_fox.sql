CREATE TABLE "journal"."provider_configuration" (
	"owner_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"models" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"disclosure_version" text,
	"disclosure_accepted_at" timestamp with time zone,
	"revision" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_configuration_pk" PRIMARY KEY("owner_id","provider_id"),
	CONSTRAINT "provider_configuration_id_valid" CHECK ("journal"."provider_configuration"."provider_id" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
	CONSTRAINT "provider_configuration_disclosure_consistent" CHECK (("journal"."provider_configuration"."disclosure_version" is null and "journal"."provider_configuration"."disclosure_accepted_at" is null) or ("journal"."provider_configuration"."disclosure_version" ~ '^[a-f0-9]{64}$' and "journal"."provider_configuration"."disclosure_accepted_at" is not null)),
	CONSTRAINT "provider_configuration_revision_positive" CHECK ("journal"."provider_configuration"."revision" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."provider_credential" (
	"owner_id" uuid NOT NULL,
	"provider_id" text NOT NULL,
	"ciphertext" text NOT NULL,
	"nonce" text NOT NULL,
	"encryption_version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "provider_credential_pk" PRIMARY KEY("owner_id","provider_id"),
	CONSTRAINT "provider_credential_id_valid" CHECK ("journal"."provider_credential"."provider_id" ~ '^[a-z0-9][a-z0-9._-]{0,99}$'),
	CONSTRAINT "provider_credential_ciphertext_not_blank" CHECK (length("journal"."provider_credential"."ciphertext") > 0),
	CONSTRAINT "provider_credential_nonce_not_blank" CHECK (length("journal"."provider_credential"."nonce") > 0),
	CONSTRAINT "provider_credential_version_positive" CHECK ("journal"."provider_credential"."encryption_version" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."settings_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result_revision" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "settings_api_idempotency_pk" PRIMARY KEY("owner_id","operation","idempotency_key"),
	CONSTRAINT "settings_api_idempotency_operation_not_blank" CHECK (length("journal"."settings_api_idempotency"."operation") > 0),
	CONSTRAINT "settings_api_idempotency_key_not_blank" CHECK (length("journal"."settings_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "settings_api_idempotency_request_hash_sha256" CHECK ("journal"."settings_api_idempotency"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "settings_api_idempotency_revision_positive" CHECK ("journal"."settings_api_idempotency"."result_revision" > 0)
);
--> statement-breakpoint
ALTER TABLE "journal"."provider_configuration" ADD CONSTRAINT "provider_configuration_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."provider_credential" ADD CONSTRAINT "provider_credential_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."settings_api_idempotency" ADD CONSTRAINT "settings_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;