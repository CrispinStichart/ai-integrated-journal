CREATE TABLE "journal"."search_fragment" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"source_kind" text NOT NULL,
	"layer" text NOT NULL,
	"source_id" uuid NOT NULL,
	"source_revision_id" uuid NOT NULL,
	"source_revision" integer NOT NULL,
	"journal_day_id" uuid,
	"journal_date" date,
	"contribution_id" uuid,
	"transcript_id" uuid,
	"artifact_id" uuid,
	"memory_id" uuid,
	"processor_id" uuid,
	"processor_version_id" uuid,
	"contribution_type" text,
	"result_type" text,
	"authority" "contribution_authority" NOT NULL,
	"content" text NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', coalesce(content, ''))) STORED NOT NULL,
	"indexed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "search_fragment_revision_positive" CHECK ("journal"."search_fragment"."source_revision" > 0),
	CONSTRAINT "search_fragment_content_not_blank" CHECK (length(btrim("journal"."search_fragment"."content")) > 0),
	CONSTRAINT "search_fragment_source_kind_valid" CHECK ("journal"."search_fragment"."source_kind" in ('contribution_revision', 'transcript_revision', 'artifact_version', 'artifact_manual_revision', 'memory_revision')),
	CONSTRAINT "search_fragment_layer_valid" CHECK ("journal"."search_fragment"."layer" in ('typed_text', 'nudge_response', 'raw_stt', 'corrected', 'cleaned', 'observation', 'interpretation', 'summary', 'memory')),
	CONSTRAINT "search_fragment_location_consistent" CHECK (("journal"."search_fragment"."memory_id" is not null and "journal"."search_fragment"."journal_day_id" is null and "journal"."search_fragment"."journal_date" is null) or ("journal"."search_fragment"."memory_id" is null and "journal"."search_fragment"."journal_day_id" is not null and "journal"."search_fragment"."journal_date" is not null))
);
--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_journal_day_id_journal_day_id_fk" FOREIGN KEY ("journal_day_id") REFERENCES "journal"."journal_day"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_contribution_id_contribution_id_fk" FOREIGN KEY ("contribution_id") REFERENCES "journal"."contribution"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_transcript_id_transcript_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "journal"."transcript"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_artifact_id_processor_artifact_id_fk" FOREIGN KEY ("artifact_id") REFERENCES "journal"."processor_artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_memory_id_memory_id_fk" FOREIGN KEY ("memory_id") REFERENCES "journal"."memory"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_processor_id_processor_installation_id_fk" FOREIGN KEY ("processor_id") REFERENCES "journal"."processor_installation"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."search_fragment" ADD CONSTRAINT "search_fragment_processor_version_id_processor_version_id_fk" FOREIGN KEY ("processor_version_id") REFERENCES "journal"."processor_version"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "search_fragment_source_revision_unique" ON "journal"."search_fragment" USING btree ("source_kind","source_revision_id");--> statement-breakpoint
CREATE INDEX "search_fragment_vector_idx" ON "journal"."search_fragment" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "search_fragment_owner_rank_idx" ON "journal"."search_fragment" USING btree ("owner_id","journal_date","id");--> statement-breakpoint
CREATE INDEX "search_fragment_filter_idx" ON "journal"."search_fragment" USING btree ("owner_id","layer","authority","processor_id");--> statement-breakpoint

CREATE FUNCTION "journal"."lexical_search_query"(input text) RETURNS tsquery
LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE
  lexemes text[];
  expression text;
BEGIN
  IF input ~ '"' THEN
    RETURN websearch_to_tsquery('english', input);
  END IF;
  SELECT tsvector_to_array(to_tsvector('english', replace(input, '*', ''))) INTO lexemes;
  IF coalesce(array_length(lexemes, 1), 0) = 0 THEN
    RETURN websearch_to_tsquery('english', input);
  END IF;
  SELECT string_agg(quote_literal(lexeme) || ':*', ' & ' ORDER BY lexeme)
    INTO expression FROM unnest(lexemes) AS lexeme;
  RETURN to_tsquery('english', expression);
END;
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."search_payload_text"(payload jsonb) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT coalesce(string_agg(trim(both '"' from value::text), ' '), '')
  FROM jsonb_path_query(payload, '$.** ? (@.type() == "string" || @.type() == "number" || @.type() == "boolean")') AS values(value)
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."refresh_artifact_search"(target_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  artifact_record record;
  source_record record;
  fragment_layer text;
  searchable_text text;
BEGIN
  DELETE FROM "journal"."search_fragment" WHERE artifact_id = target_id;
  SELECT artifact.*, day.user_id, day.journal_date, installation.key AS processor_key,
         installation.display_name, contribution.source_type, contribution.deleted_at
    INTO artifact_record
    FROM "journal"."processor_artifact" artifact
    JOIN "journal"."journal_day" day ON day.id = artifact.target_journal_day_id
    JOIN "journal"."processor_installation" installation ON installation.id = artifact.processor_id
    LEFT JOIN "journal"."contribution" contribution ON contribution.id = artifact.target_contribution_id
   WHERE artifact.id = target_id;
  IF NOT FOUND OR NOT artifact_record.active OR artifact_record.deleted_at IS NOT NULL THEN RETURN; END IF;
  fragment_layer := CASE
    WHEN artifact_record.processor_key IN ('summary', 'accomplishments') THEN 'summary'
    WHEN artifact_record.kind = 'observation' THEN 'observation'
    ELSE 'interpretation'
  END;

  SELECT manual.id, manual.revision, manual.payload, generated.processor_version_id
    INTO source_record
    FROM "journal"."processor_artifact_manual_revision" manual
    LEFT JOIN LATERAL (
      SELECT version.processor_version_id
      FROM "journal"."processor_artifact_version" version
      JOIN "journal"."processor_result" result ON result.id = version.source_result_id
      WHERE version.artifact_id = target_id AND version.lifecycle = 'active' AND result.stale_at IS NULL
      ORDER BY version.revision DESC LIMIT 1
    ) generated ON true
   WHERE manual.artifact_id = target_id AND manual.active AND manual.stale_at IS NULL
   ORDER BY manual.revision DESC LIMIT 1;
  IF FOUND THEN
    searchable_text := "journal"."search_payload_text"(source_record.payload);
    IF length(btrim(searchable_text)) > 0 THEN
      INSERT INTO "journal"."search_fragment" (
        id, owner_id, source_kind, layer, source_id, source_revision_id, source_revision,
        journal_day_id, journal_date, contribution_id, artifact_id, processor_id,
        processor_version_id, contribution_type, result_type, authority, content
      ) VALUES (
        source_record.id, artifact_record.user_id, 'artifact_manual_revision', fragment_layer,
        target_id, source_record.id, source_record.revision, artifact_record.target_journal_day_id,
        artifact_record.journal_date, artifact_record.target_contribution_id, target_id,
        artifact_record.processor_id, source_record.processor_version_id, artifact_record.source_type,
        artifact_record.kind, 'manual', searchable_text
      );
    END IF;
    RETURN;
  END IF;

  SELECT version.id, version.revision, version.payload, version.processor_version_id
    INTO source_record
    FROM "journal"."processor_artifact_version" version
    JOIN "journal"."processor_result" result ON result.id = version.source_result_id
   WHERE version.artifact_id = target_id AND version.lifecycle = 'active' AND result.stale_at IS NULL
   ORDER BY version.revision DESC LIMIT 1;
  IF FOUND THEN
    searchable_text := "journal"."search_payload_text"(source_record.payload);
    IF length(btrim(searchable_text)) > 0 THEN
      INSERT INTO "journal"."search_fragment" (
        id, owner_id, source_kind, layer, source_id, source_revision_id, source_revision,
        journal_day_id, journal_date, contribution_id, artifact_id, processor_id,
        processor_version_id, contribution_type, result_type, authority, content
      ) VALUES (
        source_record.id, artifact_record.user_id, 'artifact_version', fragment_layer,
        target_id, source_record.id, source_record.revision, artifact_record.target_journal_day_id,
        artifact_record.journal_date, artifact_record.target_contribution_id, target_id,
        artifact_record.processor_id, source_record.processor_version_id, artifact_record.source_type,
        artifact_record.kind, artifact_record.authority, searchable_text
      );
    END IF;
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."refresh_contribution_search"(target_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  source_record record;
  artifact_id uuid;
BEGIN
  DELETE FROM "journal"."search_fragment" WHERE contribution_id = target_id AND source_kind = 'contribution_revision';
  SELECT contribution.*, revision.id AS revision_id, revision.revision AS revision_number,
         revision.text, revision.authority, day.user_id, day.journal_date
    INTO source_record
    FROM "journal"."contribution" contribution
    JOIN "journal"."journal_day" day ON day.id = contribution.journal_day_id
    JOIN "journal"."contribution_revision" revision ON revision.id = contribution.current_revision_id
   WHERE contribution.id = target_id;
  IF FOUND AND source_record.deleted_at IS NULL
     AND source_record.source_type IN ('typed_text', 'nudge_response')
     AND length(btrim(source_record.text)) > 0 THEN
    INSERT INTO "journal"."search_fragment" (
      id, owner_id, source_kind, layer, source_id, source_revision_id, source_revision,
      journal_day_id, journal_date, contribution_id, contribution_type, authority, content
    ) VALUES (
      source_record.revision_id, source_record.user_id, 'contribution_revision',
      source_record.source_type::text, target_id, source_record.revision_id,
      source_record.revision_number, source_record.journal_day_id, source_record.journal_date,
      target_id, source_record.source_type::text, source_record.authority, source_record.text
    );
  END IF;
  FOR artifact_id IN SELECT id FROM "journal"."processor_artifact" WHERE target_contribution_id = target_id LOOP
    PERFORM "journal"."refresh_artifact_search"(artifact_id);
  END LOOP;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."refresh_transcript_search"(target_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source_record record;
BEGIN
  DELETE FROM "journal"."search_fragment" WHERE transcript_id = target_id;
  SELECT transcript.id AS transcript_id, transcript.layer, revision.id AS revision_id,
         revision.revision, revision.text, revision.authority, revision.stale_at,
         recording.contribution_id, contribution.source_type, contribution.deleted_at,
         day.id AS journal_day_id, day.user_id, day.journal_date
    INTO source_record
    FROM "journal"."transcript" transcript
    JOIN "journal"."transcript_revision" revision ON revision.id = transcript.current_revision_id
    JOIN "journal"."recording" recording ON recording.id = transcript.recording_id
    JOIN "journal"."contribution" contribution ON contribution.id = recording.contribution_id
    JOIN "journal"."journal_day" day ON day.id = contribution.journal_day_id
   WHERE transcript.id = target_id;
  IF FOUND AND source_record.deleted_at IS NULL AND source_record.stale_at IS NULL
     AND length(btrim(source_record.text)) > 0 THEN
    INSERT INTO "journal"."search_fragment" (
      id, owner_id, source_kind, layer, source_id, source_revision_id, source_revision,
      journal_day_id, journal_date, contribution_id, transcript_id, contribution_type,
      authority, content
    ) VALUES (
      source_record.revision_id, source_record.user_id, 'transcript_revision', source_record.layer::text,
      target_id, source_record.revision_id, source_record.revision, source_record.journal_day_id,
      source_record.journal_date, source_record.contribution_id, target_id,
      source_record.source_type::text, source_record.authority, source_record.text
    );
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."refresh_memory_search"(target_id uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE source_record record;
BEGIN
  DELETE FROM "journal"."search_fragment" WHERE memory_id = target_id;
  SELECT memory.*, revision.id AS revision_id, revision.revision AS revision_number,
         revision.content, revision.creator
    INTO source_record
    FROM "journal"."memory" memory
    JOIN "journal"."memory_revision" revision ON revision.id = memory.current_revision_id
   WHERE memory.id = target_id;
  IF FOUND AND source_record.deleted_at IS NULL AND source_record.enabled
     AND source_record.approval_state = 'approved' AND length(btrim(source_record.content)) > 0 THEN
    INSERT INTO "journal"."search_fragment" (
      id, owner_id, source_kind, layer, source_id, source_revision_id, source_revision,
      memory_id, result_type, authority, content
    ) VALUES (
      source_record.revision_id, source_record.owner_id, 'memory_revision', 'memory', target_id,
      source_record.revision_id, source_record.revision_number, target_id, 'memory',
      CASE WHEN source_record.creator = 'user' THEN 'manual'::"contribution_authority"
           ELSE 'generated'::"contribution_authority" END,
      source_record.content
    );
  END IF;
END;
$$;--> statement-breakpoint

CREATE FUNCTION "journal"."maintain_search_fragments"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'contribution' THEN
    PERFORM "journal"."refresh_contribution_search"(NEW.id);
    FOR target_id IN
      SELECT transcript.id FROM "journal"."transcript" transcript
      JOIN "journal"."recording" recording ON recording.id = transcript.recording_id
      WHERE recording.contribution_id = NEW.id
    LOOP PERFORM "journal"."refresh_transcript_search"(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'transcript' THEN
    PERFORM "journal"."refresh_transcript_search"(NEW.id);
  ELSIF TG_TABLE_NAME = 'transcript_revision' THEN
    SELECT id INTO target_id FROM "journal"."transcript" WHERE current_revision_id = NEW.id;
    IF target_id IS NOT NULL THEN PERFORM "journal"."refresh_transcript_search"(target_id); END IF;
  ELSIF TG_TABLE_NAME = 'processor_artifact' THEN
    PERFORM "journal"."refresh_artifact_search"(NEW.id);
  ELSIF TG_TABLE_NAME IN ('processor_artifact_version', 'processor_artifact_manual_revision') THEN
    PERFORM "journal"."refresh_artifact_search"(NEW.artifact_id);
  ELSIF TG_TABLE_NAME = 'processor_result' THEN
    FOR target_id IN SELECT artifact_id FROM "journal"."processor_artifact_version" WHERE source_result_id = NEW.id
    LOOP PERFORM "journal"."refresh_artifact_search"(target_id); END LOOP;
  ELSIF TG_TABLE_NAME = 'memory' THEN
    PERFORM "journal"."refresh_memory_search"(NEW.id);
  ELSIF TG_TABLE_NAME = 'memory_revision' THEN
    SELECT id INTO target_id FROM "journal"."memory" WHERE current_revision_id = NEW.id;
    IF target_id IS NOT NULL THEN PERFORM "journal"."refresh_memory_search"(target_id); END IF;
  END IF;
  RETURN NEW;
END;
$$;--> statement-breakpoint

CREATE TRIGGER search_contribution_changed AFTER INSERT OR UPDATE OF current_revision_id, deleted_at, journal_day_id ON "journal"."contribution" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_transcript_changed AFTER INSERT OR UPDATE OF current_revision_id ON "journal"."transcript" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_transcript_revision_changed AFTER UPDATE OF stale_at ON "journal"."transcript_revision" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_artifact_changed AFTER INSERT OR UPDATE OF active, target_journal_day_id, target_contribution_id, authority ON "journal"."processor_artifact" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_artifact_version_changed AFTER INSERT OR UPDATE OF lifecycle, payload ON "journal"."processor_artifact_version" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_artifact_manual_changed AFTER INSERT OR UPDATE OF active, stale_at, payload ON "journal"."processor_artifact_manual_revision" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_processor_result_changed AFTER UPDATE OF stale_at, lifecycle ON "journal"."processor_result" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_memory_changed AFTER INSERT OR UPDATE OF current_revision_id, approval_state, enabled, deleted_at ON "journal"."memory" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint
CREATE TRIGGER search_memory_revision_added AFTER INSERT ON "journal"."memory_revision" FOR EACH ROW EXECUTE FUNCTION "journal"."maintain_search_fragments"();--> statement-breakpoint

SELECT "journal"."refresh_contribution_search"(id) FROM "journal"."contribution";--> statement-breakpoint
SELECT "journal"."refresh_transcript_search"(id) FROM "journal"."transcript";--> statement-breakpoint
SELECT "journal"."refresh_artifact_search"(id) FROM "journal"."processor_artifact";--> statement-breakpoint
SELECT "journal"."refresh_memory_search"(id) FROM "journal"."memory";
