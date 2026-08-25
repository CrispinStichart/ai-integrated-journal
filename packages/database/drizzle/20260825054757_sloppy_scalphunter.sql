CREATE TYPE "public"."deletion_request_status" AS ENUM('pending', 'purging', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retention_blob_kind" AS ENUM('final_audio', 'staging_chunk', 'provider_raw_response', 'export_archive');--> statement-breakpoint
CREATE TYPE "public"."retention_cleanup_status" AS ENUM('pending', 'deleted', 'failed');--> statement-breakpoint
CREATE TYPE "public"."retention_entity_kind" AS ENUM('journal_day', 'contribution', 'recording_audio', 'provider_raw_response');--> statement-breakpoint
CREATE TABLE "journal"."deletion_tombstone" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"entity_kind" "retention_entity_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"deleted_at" timestamp with time zone NOT NULL,
	"generation" integer NOT NULL,
	"correlation_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "deletion_tombstone_generation_positive" CHECK ("journal"."deletion_tombstone"."generation" > 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."permanent_deletion_request" (
	"id" uuid PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"entity_kind" "retention_entity_kind" NOT NULL,
	"entity_id" uuid NOT NULL,
	"tombstone_id" uuid NOT NULL,
	"generation" integer NOT NULL,
	"status" "deletion_request_status" DEFAULT 'pending' NOT NULL,
	"eligible_at" timestamp with time zone NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"backup_checkpoint" text DEFAULT 'not_configured' NOT NULL,
	"browser_purge_acknowledged" boolean DEFAULT false NOT NULL,
	"error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "permanent_deletion_request_generation_positive" CHECK ("journal"."permanent_deletion_request"."generation" > 0),
	CONSTRAINT "permanent_deletion_request_attempts_nonnegative" CHECK ("journal"."permanent_deletion_request"."attempts" >= 0),
	CONSTRAINT "permanent_deletion_request_backup_state_valid" CHECK ("journal"."permanent_deletion_request"."backup_checkpoint" in ('not_configured', 'pending', 'committed')),
	CONSTRAINT "permanent_deletion_request_completion_consistent" CHECK (("journal"."permanent_deletion_request"."status" = 'completed' and "journal"."permanent_deletion_request"."completed_at" is not null) or ("journal"."permanent_deletion_request"."status" <> 'completed' and "journal"."permanent_deletion_request"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "journal"."retention_blob_cleanup_item" (
	"request_id" uuid NOT NULL,
	"blob_key" text NOT NULL,
	"blob_kind" "retention_blob_kind" NOT NULL,
	"status" "retention_cleanup_status" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_blob_cleanup_item_pk" PRIMARY KEY("request_id","blob_key"),
	CONSTRAINT "retention_blob_cleanup_key_not_blank" CHECK (length("journal"."retention_blob_cleanup_item"."blob_key") > 0),
	CONSTRAINT "retention_blob_cleanup_attempts_nonnegative" CHECK ("journal"."retention_blob_cleanup_item"."attempts" >= 0)
);
--> statement-breakpoint
CREATE TABLE "journal"."retention_policy" (
	"owner_id" uuid PRIMARY KEY NOT NULL,
	"material_grace_days" integer DEFAULT 30 NOT NULL,
	"audio_grace_days" integer DEFAULT 30 NOT NULL,
	"raw_response_retention_days" integer DEFAULT 30 NOT NULL,
	"original_audio_retention" text DEFAULT 'indefinite' NOT NULL,
	"deletion_generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "retention_policy_material_grace_bounded" CHECK ("journal"."retention_policy"."material_grace_days" between 0 and 3650),
	CONSTRAINT "retention_policy_audio_grace_bounded" CHECK ("journal"."retention_policy"."audio_grace_days" between 0 and 3650),
	CONSTRAINT "retention_policy_raw_response_bounded" CHECK ("journal"."retention_policy"."raw_response_retention_days" between 0 and 3650),
	CONSTRAINT "retention_policy_audio_default_valid" CHECK ("journal"."retention_policy"."original_audio_retention" in ('indefinite', '30_days', '90_days', '365_days')),
	CONSTRAINT "retention_policy_generation_nonnegative" CHECK ("journal"."retention_policy"."deletion_generation" >= 0)
);
--> statement-breakpoint
ALTER TABLE "journal"."deletion_tombstone" ADD CONSTRAINT "deletion_tombstone_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."permanent_deletion_request" ADD CONSTRAINT "permanent_deletion_request_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."permanent_deletion_request" ADD CONSTRAINT "permanent_deletion_request_tombstone_id_deletion_tombstone_id_fk" FOREIGN KEY ("tombstone_id") REFERENCES "journal"."deletion_tombstone"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."retention_blob_cleanup_item" ADD CONSTRAINT "retention_blob_cleanup_item_request_id_permanent_deletion_request_id_fk" FOREIGN KEY ("request_id") REFERENCES "journal"."permanent_deletion_request"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "journal"."retention_policy" ADD CONSTRAINT "retention_policy_owner_id_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "journal"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_tombstone_owner_kind_entity_unique" ON "journal"."deletion_tombstone" USING btree ("owner_id","entity_kind","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "deletion_tombstone_owner_generation_unique" ON "journal"."deletion_tombstone" USING btree ("owner_id","generation");--> statement-breakpoint
CREATE INDEX "deletion_tombstone_owner_generation_idx" ON "journal"."deletion_tombstone" USING btree ("owner_id","generation");--> statement-breakpoint
CREATE UNIQUE INDEX "permanent_deletion_request_owner_kind_entity_unique" ON "journal"."permanent_deletion_request" USING btree ("owner_id","entity_kind","entity_id");--> statement-breakpoint
CREATE INDEX "permanent_deletion_request_work_idx" ON "journal"."permanent_deletion_request" USING btree ("status","eligible_at","id");--> statement-breakpoint
CREATE INDEX "retention_blob_cleanup_pending_idx" ON "journal"."retention_blob_cleanup_item" USING btree ("status","request_id");--> statement-breakpoint
-- Permanent deletion is the only path that deletes source identities. Make the
-- content graph cascade from an explicitly verified source root; normal edits
-- remain append-only and soft deletion never executes DELETE.
DO $$
DECLARE
  fk record;
  definition text;
BEGIN
  FOR fk IN
    SELECT con.oid, con.conname, con.conrelid::regclass AS child_table
    FROM pg_constraint con
    JOIN pg_class parent ON parent.oid = con.confrelid
    JOIN pg_namespace namespace ON namespace.oid = parent.relnamespace
    WHERE con.contype = 'f'
      AND namespace.nspname = 'journal'
      AND parent.relname IN (
        'journal_day', 'contribution', 'contribution_revision', 'recording',
        'recording_upload', 'transcription_run', 'transcript',
        'transcript_revision', 'transcript_cleanup_run', 'processor_run',
        'processor_result', 'processor_artifact', 'processor_artifact_version',
        'processor_artifact_manual_revision', 'processor_reconciliation',
        'search_fragment'
      )
  LOOP
    definition := pg_get_constraintdef(fk.oid);
    definition := regexp_replace(
      definition,
      ' ON DELETE (NO ACTION|RESTRICT|SET NULL|SET DEFAULT|CASCADE)',
      '',
      'i'
    );
    EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', fk.child_table, fk.conname);
    EXECUTE format(
      'ALTER TABLE %s ADD CONSTRAINT %I %s ON DELETE CASCADE',
      fk.child_table,
      fk.conname,
      definition
    );
  END LOOP;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal.purge_contribution(
  requested_owner_id uuid,
  requested_contribution_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, journal
AS $$
DECLARE
  owned_deleted boolean;
BEGIN
  SELECT c.deleted_at IS NOT NULL INTO owned_deleted
  FROM journal.contribution c
  JOIN journal.journal_day d ON d.id = c.journal_day_id
  WHERE c.id = requested_contribution_id
    AND d.user_id = requested_owner_id
  FOR UPDATE OF c;

  IF owned_deleted IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'contribution is not owned and recoverably deleted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM journal.deletion_tombstone t
    WHERE t.owner_id = requested_owner_id
      AND t.entity_kind = 'contribution'
      AND t.entity_id = requested_contribution_id
  ) THEN
    RAISE EXCEPTION 'content-free tombstone must commit before purge';
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS retention_affected_runs(id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS retention_affected_artifacts(id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS retention_affected_fragments(id uuid PRIMARY KEY) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS retention_affected_feedback(id uuid PRIMARY KEY) ON COMMIT DROP;
  TRUNCATE retention_affected_runs, retention_affected_artifacts,
    retention_affected_fragments, retention_affected_feedback;

  WITH RECURSIVE affected_runs(id) AS (
    SELECT run.id
    FROM journal.processor_run run
    WHERE run.target_contribution_id = requested_contribution_id
       OR run.target_journal_day_id = (
         SELECT contribution.journal_day_id
         FROM journal.contribution contribution
         WHERE contribution.id = requested_contribution_id
       )
    UNION
    SELECT input.run_id
    FROM journal.processor_run_input input
    JOIN journal.contribution_revision revision
      ON revision.id = input.contribution_revision_id
    WHERE revision.contribution_id = requested_contribution_id
    UNION
    SELECT input.run_id
    FROM journal.processor_run_input input
    JOIN journal.transcript_revision revision
      ON revision.id = input.transcript_revision_id
    JOIN journal.transcript transcript ON transcript.id = revision.transcript_id
    JOIN journal.recording recording ON recording.id = transcript.recording_id
    WHERE recording.contribution_id = requested_contribution_id
    UNION
    SELECT downstream.run_id
    FROM journal.processor_run_input downstream
    JOIN journal.processor_result result
      ON result.id = downstream.processor_result_id
    JOIN affected_runs upstream ON upstream.id = result.run_id
  )
  INSERT INTO retention_affected_runs(id)
  SELECT id FROM affected_runs
  ON CONFLICT DO NOTHING;

  INSERT INTO retention_affected_artifacts(id)
  SELECT artifact.id
  FROM journal.processor_artifact artifact
  WHERE artifact.target_contribution_id = requested_contribution_id
     OR artifact.target_journal_day_id = (
       SELECT contribution.journal_day_id
       FROM journal.contribution contribution
       WHERE contribution.id = requested_contribution_id
     )
     OR EXISTS (
       SELECT 1 FROM journal.processor_artifact_version version
       JOIN retention_affected_runs run ON run.id = version.run_id
       WHERE version.artifact_id = artifact.id
     )
  ON CONFLICT DO NOTHING;

  INSERT INTO retention_affected_fragments(id)
  SELECT fragment.id
  FROM journal.search_fragment fragment
  WHERE fragment.contribution_id = requested_contribution_id
     OR fragment.transcript_id IN (
       SELECT transcript.id
       FROM journal.transcript transcript
       JOIN journal.recording recording ON recording.id = transcript.recording_id
       WHERE recording.contribution_id = requested_contribution_id
     )
     OR fragment.artifact_id IN (SELECT id FROM retention_affected_artifacts)
  ON CONFLICT DO NOTHING;

  DELETE FROM journal.grounded_answer answer
  WHERE EXISTS (
    SELECT 1 FROM journal.grounded_answer_citation citation
    WHERE citation.answer_id = answer.id
      AND citation.fragment_id IN (SELECT id FROM retention_affected_fragments)
  );

  INSERT INTO retention_affected_feedback(id)
  SELECT item.id
  FROM journal.feedback item
  WHERE (item.target_kind = 'transcript_revision' AND item.target_id IN (
      SELECT revision.id
      FROM journal.transcript_revision revision
      JOIN journal.transcript transcript ON transcript.id = revision.transcript_id
      JOIN journal.recording recording ON recording.id = transcript.recording_id
      WHERE recording.contribution_id = requested_contribution_id
    ))
    OR (item.target_kind = 'processor_result' AND item.target_id IN (
      SELECT result.id FROM journal.processor_result result
      WHERE result.run_id IN (SELECT id FROM retention_affected_runs)
    ))
    OR (item.target_kind = 'artifact_version' AND item.target_id IN (
      SELECT version.id FROM journal.processor_artifact_version version
      WHERE version.artifact_id IN (SELECT id FROM retention_affected_artifacts)
    ))
  ON CONFLICT DO NOTHING;
  DELETE FROM journal.memory_api_idempotency
  WHERE feedback_id IN (SELECT id FROM retention_affected_feedback);
  DELETE FROM journal.audit_event
  WHERE entity_type = 'feedback'
    AND entity_id IN (SELECT id FROM retention_affected_feedback);
  DELETE FROM journal.feedback
  WHERE id IN (SELECT id FROM retention_affected_feedback);

  DELETE FROM journal.audit_event
  WHERE (entity_type = 'processor_artifact'
      AND entity_id IN (SELECT id FROM retention_affected_artifacts))
     OR (entity_type = 'transcript' AND entity_id IN (
       SELECT transcript.id
       FROM journal.transcript transcript
       JOIN journal.recording recording ON recording.id = transcript.recording_id
       WHERE recording.contribution_id = requested_contribution_id
     ));
  DELETE FROM journal.processor_artifact
  WHERE id IN (SELECT id FROM retention_affected_artifacts);
  DELETE FROM journal.processor_run run
  WHERE run.id IN (SELECT id FROM retention_affected_runs);
  DELETE FROM journal.audit_event
  WHERE entity_type IN ('contribution', 'recording')
    AND (
      entity_id = requested_contribution_id
      OR entity_id IN (
        SELECT id FROM journal.recording
        WHERE contribution_id = requested_contribution_id
      )
    );
  DELETE FROM journal.contribution WHERE id = requested_contribution_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal.purge_journal_day(
  requested_owner_id uuid,
  requested_journal_day_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, journal
AS $$
DECLARE
  contribution_id uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM journal.journal_day
    WHERE id = requested_journal_day_id AND user_id = requested_owner_id
  ) OR NOT EXISTS (
    SELECT 1 FROM journal.deletion_tombstone
    WHERE owner_id = requested_owner_id
      AND entity_kind = 'journal_day'
      AND entity_id = requested_journal_day_id
  ) THEN
    RAISE EXCEPTION 'journal day is not owned or tombstoned';
  END IF;

  FOR contribution_id IN
    SELECT id FROM journal.contribution
    WHERE journal_day_id = requested_journal_day_id
    ORDER BY id
  LOOP
    PERFORM journal.purge_contribution(requested_owner_id, contribution_id);
  END LOOP;
  DELETE FROM journal.audit_event
  WHERE entity_type = 'journal_day' AND entity_id = requested_journal_day_id;
  DELETE FROM journal.journal_day WHERE id = requested_journal_day_id;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal.purge_provider_raw_response(
  requested_owner_id uuid,
  requested_raw_response_id uuid
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, journal
AS $$
DECLARE
  affected integer := 0;
  changed_rows integer := 0;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM journal.deletion_tombstone
    WHERE owner_id = requested_owner_id
      AND entity_kind = 'provider_raw_response'
      AND entity_id = requested_raw_response_id
  ) THEN
    RAISE EXCEPTION 'content-free raw-response tombstone must commit before purge';
  END IF;

  UPDATE journal.transcription_run run
  SET raw_response_id = NULL,
      raw_response_blob_key = NULL,
      raw_response_media_type = NULL,
      raw_response_byte_size = NULL,
      raw_response_sha256 = NULL,
      raw_response_provider_request_id = NULL,
      raw_response_retention = NULL,
      raw_response_expires_at = NULL
  FROM journal.recording recording,
       journal.contribution contribution,
       journal.journal_day day
  WHERE run.recording_id = recording.id
    AND recording.contribution_id = contribution.id
    AND contribution.journal_day_id = day.id
    AND day.user_id = requested_owner_id
    AND run.raw_response_id = requested_raw_response_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  affected := affected + changed_rows;

  UPDATE journal.transcript_cleanup_run run
  SET raw_response_id = NULL,
      raw_response_blob_key = NULL,
      raw_response_media_type = NULL,
      raw_response_byte_size = NULL,
      raw_response_sha256 = NULL,
      raw_response_provider_request_id = NULL,
      raw_response_retention = NULL,
      raw_response_expires_at = NULL
  FROM journal.recording recording,
       journal.contribution contribution,
       journal.journal_day day
  WHERE run.recording_id = recording.id
    AND recording.contribution_id = contribution.id
    AND contribution.journal_day_id = day.id
    AND day.user_id = requested_owner_id
    AND run.raw_response_id = requested_raw_response_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  affected := affected + changed_rows;

  UPDATE journal.processor_run run
  SET raw_response_id = NULL,
      raw_response_blob_key = NULL,
      raw_response_media_type = NULL,
      raw_response_byte_size = NULL,
      raw_response_sha256 = NULL,
      raw_response_provider_request_id = NULL,
      raw_response_retention = NULL,
      raw_response_expires_at = NULL
  FROM journal.journal_day day
  WHERE run.target_journal_day_id = day.id
    AND day.user_id = requested_owner_id
    AND run.raw_response_id = requested_raw_response_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  affected := affected + changed_rows;

  UPDATE journal.grounded_answer answer
  SET raw_response_id = NULL,
      raw_response_blob_key = NULL,
      raw_response_media_type = NULL,
      raw_response_byte_size = NULL,
      raw_response_sha256 = NULL,
      raw_response_provider_request_id = NULL,
      raw_response_retention = NULL,
      raw_response_expires_at = NULL
  WHERE answer.owner_id = requested_owner_id
    AND answer.raw_response_id = requested_raw_response_id;
  GET DIAGNOSTICS changed_rows = ROW_COUNT;
  affected := affected + changed_rows;

  IF affected = 0 THEN
    RAISE EXCEPTION 'raw response is not owned or no longer present';
  END IF;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION journal.purge_recording_audio(
  requested_owner_id uuid,
  requested_recording_id uuid,
  purged_at timestamptz
) RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, journal
AS $$
DECLARE
  target_upload_id uuid;
BEGIN
  SELECT upload.id INTO target_upload_id
  FROM journal.recording recording
  JOIN journal.recording_upload upload ON upload.recording_id = recording.id
  JOIN journal.contribution contribution ON contribution.id = recording.contribution_id
  JOIN journal.journal_day day ON day.id = contribution.journal_day_id
  WHERE recording.id = requested_recording_id
    AND day.user_id = requested_owner_id
    AND recording.audio_deleted_at IS NOT NULL
  FOR UPDATE OF recording;
  IF target_upload_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM journal.deletion_tombstone
    WHERE owner_id = requested_owner_id
      AND entity_kind = 'recording_audio'
      AND entity_id = requested_recording_id
  ) THEN
    RAISE EXCEPTION 'audio is not owned, recoverably deleted, and tombstoned';
  END IF;

  DELETE FROM journal.recording_chunk
  WHERE recording_chunk.upload_id = target_upload_id;
  UPDATE journal.transcript_evidence_span evidence
  SET start_ms = NULL,
      end_ms = NULL,
      resolution_status = 'stale',
      unresolved_reason = 'audio_permanently_deleted',
      updated_at = purged_at
  WHERE evidence.source_transcript_revision_id IN (
    SELECT revision.id
    FROM journal.transcript_revision revision
    JOIN journal.transcript transcript ON transcript.id = revision.transcript_id
    WHERE transcript.recording_id = requested_recording_id
  ) AND evidence.start_ms IS NOT NULL;
  UPDATE journal.processor_result_evidence evidence
  SET start_ms = NULL,
      end_ms = NULL,
      resolution_status = 'stale',
      unresolved_reason = 'audio_permanently_deleted',
      updated_at = purged_at
  WHERE evidence.transcript_revision_id IN (
    SELECT revision.id
    FROM journal.transcript_revision revision
    JOIN journal.transcript transcript ON transcript.id = revision.transcript_id
    WHERE transcript.recording_id = requested_recording_id
  ) AND evidence.start_ms IS NOT NULL;
  UPDATE journal.recording
  SET updated_at = purged_at
  WHERE id = requested_recording_id;
  DELETE FROM journal.audit_event
  WHERE entity_type = 'recording' AND entity_id = requested_recording_id;
END $$;
