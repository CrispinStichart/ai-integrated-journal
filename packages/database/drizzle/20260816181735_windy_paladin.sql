CREATE TABLE "journal"."journal_api_idempotency" (
	"owner_id" uuid NOT NULL,
	"operation" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"contribution_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_api_idempotency_operation_not_blank" CHECK (length("journal"."journal_api_idempotency"."operation") > 0),
	CONSTRAINT "journal_api_idempotency_key_not_blank" CHECK (length("journal"."journal_api_idempotency"."idempotency_key") > 0),
	CONSTRAINT "journal_api_idempotency_request_hash_sha256" CHECK ("journal"."journal_api_idempotency"."request_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "journal"."journal_api_idempotency" ADD CONSTRAINT "journal_api_idempotency_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "journal_api_idempotency_owner_operation_key_unique" ON "journal"."journal_api_idempotency" USING btree ("owner_id","operation","idempotency_key");