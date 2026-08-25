ALTER TABLE "journal"."grounded_answer_citation" ADD COLUMN "normalization" text NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD COLUMN "offset_unit" text NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD COLUMN "start_utf16" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD COLUMN "end_utf16" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD COLUMN "quote_sha256" text NOT NULL;--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD CONSTRAINT "grounded_answer_citation_evidence_contract" CHECK ("journal"."grounded_answer_citation"."normalization" = 'NFC_LF_V1' and "journal"."grounded_answer_citation"."offset_unit" = 'utf16_code_unit' and "journal"."grounded_answer_citation"."start_utf16" = 0 and "journal"."grounded_answer_citation"."end_utf16" between 1 and 2000);--> statement-breakpoint
ALTER TABLE "journal"."grounded_answer_citation" ADD CONSTRAINT "grounded_answer_citation_quote_sha256" CHECK ("journal"."grounded_answer_citation"."quote_sha256" ~ '^[0-9a-f]{64}$');