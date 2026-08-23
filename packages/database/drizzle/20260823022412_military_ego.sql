CREATE TYPE "public"."evidence_resolution_status" AS ENUM('resolved', 'unresolved', 'stale');--> statement-breakpoint
CREATE TABLE "journal"."transcript_evidence_span" (
	"id" uuid PRIMARY KEY NOT NULL,
	"dependent_transcript_revision_id" uuid NOT NULL,
	"source_transcript_revision_id" uuid NOT NULL,
	"source_segment_id" uuid,
	"normalization" text DEFAULT 'NFC_LF_V1' NOT NULL,
	"offset_unit" text DEFAULT 'utf16_code_unit' NOT NULL,
	"start_utf16" integer NOT NULL,
	"end_utf16" integer NOT NULL,
	"start_ms" bigint,
	"end_ms" bigint,
	"quote" text NOT NULL,
	"quote_hash" text NOT NULL,
	"resolution_status" "evidence_resolution_status" DEFAULT 'resolved' NOT NULL,
	"unresolved_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_evidence_span_id_uuid_v7" CHECK (substring("journal"."transcript_evidence_span"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcript_evidence_span_coordinate_contract" CHECK ("journal"."transcript_evidence_span"."normalization" = 'NFC_LF_V1' and "journal"."transcript_evidence_span"."offset_unit" = 'utf16_code_unit'),
	CONSTRAINT "transcript_evidence_span_text_range_valid" CHECK ("journal"."transcript_evidence_span"."start_utf16" >= 0 and "journal"."transcript_evidence_span"."start_utf16" < "journal"."transcript_evidence_span"."end_utf16"),
	CONSTRAINT "transcript_evidence_span_audio_range_valid" CHECK (("journal"."transcript_evidence_span"."start_ms" is null and "journal"."transcript_evidence_span"."end_ms" is null) or ("journal"."transcript_evidence_span"."start_ms" >= 0 and "journal"."transcript_evidence_span"."start_ms" < "journal"."transcript_evidence_span"."end_ms")),
	CONSTRAINT "transcript_evidence_span_quote_not_empty" CHECK (length("journal"."transcript_evidence_span"."quote") > 0),
	CONSTRAINT "transcript_evidence_span_quote_hash_sha256" CHECK ("journal"."transcript_evidence_span"."quote_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "transcript_evidence_span_resolution_consistent" CHECK (("journal"."transcript_evidence_span"."resolution_status" = 'resolved' and "journal"."transcript_evidence_span"."unresolved_reason" is null) or ("journal"."transcript_evidence_span"."resolution_status" <> 'resolved' and "journal"."transcript_evidence_span"."unresolved_reason" is not null)),
	CONSTRAINT "transcript_evidence_span_reason_code_valid" CHECK ("journal"."transcript_evidence_span"."unresolved_reason" is null or "journal"."transcript_evidence_span"."unresolved_reason" ~ '^[a-z][a-z0-9_]{0,63}$')
);
--> statement-breakpoint
CREATE TABLE "journal"."transcript_segment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"transcript_revision_id" uuid NOT NULL,
	"source_segment_id" uuid,
	"ordinal" integer NOT NULL,
	"start_utf16" integer NOT NULL,
	"end_utf16" integer NOT NULL,
	"start_ms" bigint,
	"end_ms" bigint,
	"quote" text NOT NULL,
	"quote_hash" text NOT NULL,
	"provider_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "transcript_segment_id_uuid_v7" CHECK (substring("journal"."transcript_segment"."id"::text from 15 for 1) = '7'),
	CONSTRAINT "transcript_segment_ordinal_nonnegative" CHECK ("journal"."transcript_segment"."ordinal" >= 0),
	CONSTRAINT "transcript_segment_text_range_valid" CHECK ("journal"."transcript_segment"."start_utf16" >= 0 and "journal"."transcript_segment"."start_utf16" < "journal"."transcript_segment"."end_utf16"),
	CONSTRAINT "transcript_segment_audio_range_valid" CHECK (("journal"."transcript_segment"."start_ms" is null and "journal"."transcript_segment"."end_ms" is null) or ("journal"."transcript_segment"."start_ms" >= 0 and "journal"."transcript_segment"."start_ms" < "journal"."transcript_segment"."end_ms")),
	CONSTRAINT "transcript_segment_quote_not_empty" CHECK (length("journal"."transcript_segment"."quote") > 0),
	CONSTRAINT "transcript_segment_quote_hash_sha256" CHECK ("journal"."transcript_segment"."quote_hash" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "evidence_text" text;--> statement-breakpoint
UPDATE "journal"."transcript_revision"
SET "evidence_text" = normalize(replace(replace("text", E'\r\n', E'\n'), E'\r', E'\n'), NFC);--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ALTER COLUMN "evidence_text" SET NOT NULL;--> statement-breakpoint
DO $$
DECLARE
	revision_row record;
	segment_row record;
	segment_quote text;
	segment_tail text;
	relative_char integer;
	start_char integer;
	cursor_char integer;
	character_index integer;
	start_utf16 integer;
	end_utf16 integer;
	millis_hex text;
	segment_digest text;
	segment_id uuid;
	source_segment_id uuid;
BEGIN
	FOR revision_row IN
		SELECT id, source_run_id, source_revision_id, evidence_text, segments, created_at
		FROM "journal"."transcript_revision"
		WHERE jsonb_array_length(segments) > 0
		ORDER BY created_at, source_run_id NULLS LAST, revision
	LOOP
		cursor_char := 1;
		FOR segment_row IN
			SELECT value, ordinality - 1 AS ordinal
			FROM jsonb_array_elements(revision_row.segments) WITH ORDINALITY
		LOOP
			segment_quote := normalize(replace(replace(segment_row.value ->> 'text', E'\r\n', E'\n'), E'\r', E'\n'), NFC);
			IF segment_quote IS NULL OR length(segment_quote) = 0 THEN
				RAISE EXCEPTION 'Cannot migrate an empty transcript segment for revision %', revision_row.id;
			END IF;
			segment_tail := substring(revision_row.evidence_text FROM cursor_char);
			relative_char := strpos(segment_tail, segment_quote);
			IF relative_char = 0 THEN
				RAISE EXCEPTION 'Cannot resolve transcript segment % for revision %', segment_row.ordinal, revision_row.id;
			END IF;
			start_char := cursor_char + relative_char - 1;
			start_utf16 := 0;
			IF start_char > 1 THEN
				FOR character_index IN 1..(start_char - 1) LOOP
					start_utf16 := start_utf16 + CASE WHEN ascii(substring(revision_row.evidence_text FROM character_index FOR 1)) > 65535 THEN 2 ELSE 1 END;
				END LOOP;
			END IF;
			end_utf16 := start_utf16;
			FOR character_index IN 1..length(segment_quote) LOOP
				end_utf16 := end_utf16 + CASE WHEN ascii(substring(segment_quote FROM character_index FOR 1)) > 65535 THEN 2 ELSE 1 END;
			END LOOP;
			millis_hex := lpad(to_hex(floor(extract(epoch FROM revision_row.created_at) * 1000)::bigint), 12, '0');
			segment_digest := md5(revision_row.id::text || ':' || segment_row.ordinal::text);
			segment_id := (substring(millis_hex FROM 1 FOR 8) || '-' || substring(millis_hex FROM 9 FOR 4) || '-7' || substring(segment_digest FROM 1 FOR 3) || '-8' || substring(segment_digest FROM 4 FOR 3) || '-' || substring(segment_digest FROM 7 FOR 12))::uuid;
			source_segment_id := NULL;
			IF revision_row.source_revision_id IS NOT NULL THEN
				SELECT id INTO source_segment_id
				FROM "journal"."transcript_segment"
				WHERE transcript_revision_id = revision_row.source_revision_id
					AND ordinal = segment_row.ordinal;
			END IF;
			INSERT INTO "journal"."transcript_segment" (
				id,
				transcript_revision_id,
				source_segment_id,
				ordinal,
				start_utf16,
				end_utf16,
				start_ms,
				end_ms,
				quote,
				quote_hash,
				provider_metadata,
				created_at
			) VALUES (
				segment_id,
				revision_row.id,
				source_segment_id,
				segment_row.ordinal,
				start_utf16,
				end_utf16,
				CASE WHEN segment_row.value #>> '{timing,status}' = 'known' THEN (segment_row.value #>> '{timing,startMs}')::bigint ELSE NULL END,
				CASE WHEN segment_row.value #>> '{timing,status}' = 'known' THEN (segment_row.value #>> '{timing,endMs}')::bigint ELSE NULL END,
				segment_quote,
				encode(sha256(convert_to(segment_quote, 'UTF8')), 'hex'),
				jsonb_build_object('words', segment_row.value -> 'words'),
				revision_row.created_at
			);
			cursor_char := start_char + length(segment_quote);
		END LOOP;
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "stale_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD COLUMN "stale_reason" text;--> statement-breakpoint
ALTER TABLE "journal"."transcript_evidence_span" ADD CONSTRAINT "transcript_evidence_span_dependent_transcript_revision_id_transcript_revision_id_fk" FOREIGN KEY ("dependent_transcript_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_evidence_span" ADD CONSTRAINT "transcript_evidence_span_source_transcript_revision_id_transcript_revision_id_fk" FOREIGN KEY ("source_transcript_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segment_revision_id_unique" ON "journal"."transcript_segment" USING btree ("transcript_revision_id","id");--> statement-breakpoint
ALTER TABLE "journal"."transcript_evidence_span" ADD CONSTRAINT "transcript_evidence_span_source_segment_fk" FOREIGN KEY ("source_transcript_revision_id","source_segment_id") REFERENCES "journal"."transcript_segment"("transcript_revision_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_segment" ADD CONSTRAINT "transcript_segment_transcript_revision_id_transcript_revision_id_fk" FOREIGN KEY ("transcript_revision_id") REFERENCES "journal"."transcript_revision"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."transcript_segment" ADD CONSTRAINT "transcript_segment_source_segment_id_fk" FOREIGN KEY ("source_segment_id") REFERENCES "journal"."transcript_segment"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "transcript_evidence_span_dependent_idx" ON "journal"."transcript_evidence_span" USING btree ("dependent_transcript_revision_id");--> statement-breakpoint
CREATE INDEX "transcript_evidence_span_source_idx" ON "journal"."transcript_evidence_span" USING btree ("source_transcript_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "transcript_segment_revision_ordinal_unique" ON "journal"."transcript_segment" USING btree ("transcript_revision_id","ordinal");--> statement-breakpoint
CREATE INDEX "transcript_segment_source_segment_idx" ON "journal"."transcript_segment" USING btree ("source_segment_id");--> statement-breakpoint
ALTER TABLE "journal"."transcript_cleanup_run" ADD CONSTRAINT "transcript_cleanup_run_staleness_consistent" CHECK (("journal"."transcript_cleanup_run"."stale_at" is null and "journal"."transcript_cleanup_run"."stale_reason" is null) or ("journal"."transcript_cleanup_run"."status" = 'succeeded' and "journal"."transcript_cleanup_run"."stale_at" is not null and "journal"."transcript_cleanup_run"."stale_reason" is not null));--> statement-breakpoint
ALTER TABLE "journal"."transcript_revision" ADD CONSTRAINT "transcript_revision_staleness_consistent" CHECK (("journal"."transcript_revision"."stale_at" is null and "journal"."transcript_revision"."stale_reason" is null) or ("journal"."transcript_revision"."stale_at" is not null and "journal"."transcript_revision"."stale_reason" is not null));
