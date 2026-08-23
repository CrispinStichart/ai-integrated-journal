ALTER TABLE "journal"."processor_result_evidence" ADD COLUMN "ordinal" integer;--> statement-breakpoint
WITH ordered_evidence AS (
  SELECT "id", row_number() OVER (
    PARTITION BY "processor_result_id"
    ORDER BY "created_at", "id"
  ) - 1 AS "ordinal"
  FROM "journal"."processor_result_evidence"
)
UPDATE "journal"."processor_result_evidence" AS evidence
SET "ordinal" = ordered_evidence."ordinal"
FROM ordered_evidence
WHERE evidence."id" = ordered_evidence."id";--> statement-breakpoint
ALTER TABLE "journal"."processor_result_evidence" ALTER COLUMN "ordinal" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "processor_result_evidence_result_ordinal_unique" ON "journal"."processor_result_evidence" USING btree ("processor_result_id","ordinal");--> statement-breakpoint
ALTER TABLE "journal"."processor_result_evidence" ADD CONSTRAINT "processor_result_evidence_ordinal_nonnegative" CHECK ("journal"."processor_result_evidence"."ordinal" >= 0);
