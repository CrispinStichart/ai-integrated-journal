import {
  EXPORT_DOWNLOAD_TTL_MILLISECONDS,
  EXPORT_MANIFEST_SCHEMA_VERSION,
  createUuidV7,
  parseUuidV7,
} from '@journal/domain';
import { and, asc, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { JournalDatabase, JournalTransaction } from './client.js';
import { createQueueJobPayload, queueNames } from './queue-contracts.js';
import { enqueueJobInTransaction } from './queue-runtime.js';
import {
  auditEvents,
  exportBlobLeases,
  exportRequests,
  exportSnapshotItems,
} from './schema.js';
import { inTransaction } from './transaction.js';

export class ExportNotFoundError extends Error {
  override readonly name = 'ExportNotFoundError';
}

export class ExportUnavailableError extends Error {
  override readonly name = 'ExportUnavailableError';
}

export class ExportConflictError extends Error {
  override readonly name = 'ExportConflictError';
}

export type ExportRow = typeof exportRequests.$inferSelect;
export type ExportBlobLeaseRow = typeof exportBlobLeases.$inferSelect;
export interface ExpiredExportArchive {
  readonly id: string;
  readonly archiveBlobKey: string | null;
}

interface SnapshotSpec {
  readonly entityType: string;
  readonly stableId: string;
  readonly versionId?: string;
  readonly journalDate?: string;
  readonly from: string;
  readonly where?: string;
}

const day = (suffix: string) =>
  `journal.journal_day d join journal.contribution c on c.journal_day_id = d.id and c.deleted_at is null ${suffix}`;

/** Every row is copied as JSONB so later revisions cannot change this archive. */
const SNAPSHOT_SPECS: readonly SnapshotSpec[] = Object.freeze([
  {
    entityType: 'owner_profile',
    stableId: 'u.id::text',
    from: 'journal.user u',
    where: 'u.id = $OWNER',
  },
  {
    entityType: 'journal_day',
    stableId: 'd.id::text',
    journalDate: 'd.journal_date',
    from: 'journal.journal_day d',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'contribution',
    stableId: 'c.id::text',
    journalDate: 'd.journal_date',
    from: day(''),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'contribution_revision',
    stableId: 'r.contribution_id::text',
    versionId: 'r.id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.contribution_revision r on r.contribution_id = c.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'recording',
    stableId: 'r.id::text',
    journalDate: 'd.journal_date',
    from: day('join journal.recording r on r.contribution_id = c.id'),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcription_run',
    stableId: 'r.id::text',
    versionId: 'r.id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcription_run r on r.recording_id = rec.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcript',
    stableId: 't.id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcript t on t.recording_id = rec.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcript_revision',
    stableId: 'r.transcript_id::text',
    versionId: 'r.id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcript t on t.recording_id = rec.id join journal.transcript_revision r on r.transcript_id = t.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcript_segment',
    stableId: 's.id::text',
    versionId: 's.transcript_revision_id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcript t on t.recording_id = rec.id join journal.transcript_revision r on r.transcript_id = t.id join journal.transcript_segment s on s.transcript_revision_id = r.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcript_evidence_span',
    stableId: 'e.id::text',
    versionId: 'e.source_transcript_revision_id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcript t on t.recording_id = rec.id join journal.transcript_revision r on r.transcript_id = t.id join journal.transcript_evidence_span e on e.source_transcript_revision_id = r.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'transcript_cleanup_run',
    stableId: 'r.id::text',
    versionId: 'r.source_corrected_revision_id::text',
    journalDate: 'd.journal_date',
    from: day(
      'join journal.recording rec on rec.contribution_id = c.id join journal.transcript_cleanup_run r on r.recording_id = rec.id',
    ),
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_run',
    stableId: 'r.id::text',
    versionId: 'r.processor_version_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_run r join journal.journal_day d on d.id = r.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_result',
    stableId: 'r.id::text',
    versionId: 'r.run_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_result r join journal.processor_run run on run.id = r.run_id join journal.journal_day d on d.id = run.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_run_input',
    stableId: "i.run_id::text || ':' || i.ordinal::text",
    versionId: 'i.run_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_run_input i join journal.processor_run run on run.id = i.run_id join journal.journal_day d on d.id = run.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_result_evidence',
    stableId: 'e.id::text',
    versionId: 'e.processor_result_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_result_evidence e join journal.processor_result r on r.id = e.processor_result_id join journal.processor_run run on run.id = r.run_id join journal.journal_day d on d.id = run.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_artifact',
    stableId: 'a.id::text',
    versionId: 'a.revision::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_artifact a join journal.journal_day d on d.id = a.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_artifact_version',
    stableId: 'v.artifact_id::text',
    versionId: 'v.id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_artifact_version v join journal.processor_artifact a on a.id = v.artifact_id join journal.journal_day d on d.id = a.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_artifact_manual_revision',
    stableId: 'm.artifact_id::text',
    versionId: 'm.id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_artifact_manual_revision m join journal.processor_artifact a on a.id = m.artifact_id join journal.journal_day d on d.id = a.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_artifact_candidate',
    stableId: 'x.id::text',
    versionId: 'x.processor_version_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_artifact_candidate x join journal.processor_artifact a on a.id = x.artifact_id join journal.journal_day d on d.id = a.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_reconciliation',
    stableId: 'r.run_id::text',
    versionId: 'r.source_result_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_reconciliation r join journal.processor_run run on run.id = r.run_id join journal.journal_day d on d.id = run.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'processor_reconciliation_outcome',
    stableId: "o.run_id::text || ':' || o.ordinal::text",
    versionId: 'o.version_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.processor_reconciliation_outcome o join journal.processor_reconciliation r on r.run_id = o.run_id join journal.processor_run run on run.id = r.run_id join journal.journal_day d on d.id = run.target_journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'memory',
    stableId: 'm.id::text',
    versionId: 'm.current_revision_id::text',
    from: 'journal.memory m',
    where: 'm.owner_id = $OWNER and m.deleted_at is null',
  },
  {
    entityType: 'memory_revision',
    stableId: 'r.memory_id::text',
    versionId: 'r.id::text',
    from: 'journal.memory_revision r join journal.memory m on m.id = r.memory_id',
    where: 'm.owner_id = $OWNER and m.deleted_at is null',
  },
  {
    entityType: 'feedback',
    stableId: 'f.id::text',
    versionId: 'f.target_id::text',
    from: 'journal.feedback f',
    where: 'f.owner_id = $OWNER',
  },
  {
    entityType: 'requirement_evaluation',
    stableId: 'r.id::text',
    versionId: 'r.processor_version_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.requirement_evaluation r join journal.journal_day d on d.id = r.journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'nudge_digest',
    stableId: 'n.id::text',
    journalDate: 'd.journal_date',
    from: 'journal.nudge_digest n join journal.journal_day d on d.id = n.journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'nudge_item',
    stableId: 'n.id::text',
    versionId: 'n.evaluation_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.nudge_item n join journal.nudge_digest digest on digest.id = n.digest_id join journal.journal_day d on d.id = digest.journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'nudge_action',
    stableId: 'a.id::text',
    versionId: 'a.digest_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.nudge_action a join journal.nudge_digest digest on digest.id = a.digest_id join journal.journal_day d on d.id = digest.journal_day_id',
    where: 'd.user_id = $OWNER',
  },
  {
    entityType: 'nudge_preference',
    stableId: 'n.owner_id::text',
    versionId: 'n.revision::text',
    from: 'journal.nudge_preference n',
    where: 'n.owner_id = $OWNER',
  },
  {
    entityType: 'grounded_answer',
    stableId: 'a.id::text',
    versionId: 'a.id::text',
    from: 'journal.grounded_answer a',
    where: 'a.owner_id = $OWNER',
  },
  {
    entityType: 'grounded_answer_citation',
    stableId: "c.answer_id::text || ':' || c.citation_id",
    versionId: 'c.source_revision_id::text',
    from: 'journal.grounded_answer_citation c join journal.grounded_answer a on a.id = c.answer_id',
    where: 'a.owner_id = $OWNER',
  },
  {
    entityType: 'reprocessing_batch',
    stableId: 'b.id::text',
    versionId: 'b.revision::text',
    from: 'journal.reprocessing_batch b',
    where: 'b.owner_id = $OWNER',
  },
  {
    entityType: 'reprocessing_batch_item',
    stableId: "i.batch_id::text || ':' || i.ordinal::text",
    versionId: 'i.batch_id::text',
    journalDate: 'd.journal_date',
    from: 'journal.reprocessing_batch_item i join journal.reprocessing_batch b on b.id = i.batch_id join journal.journal_day d on d.id = i.journal_day_id',
    where: 'b.owner_id = $OWNER',
  },
  {
    entityType: 'audit_event',
    stableId: 'a.id::text',
    versionId: 'a.revision_id::text',
    from: 'journal.audit_event a',
    where: 'a.actor_id = $OWNER',
  },
  {
    entityType: 'retention_policy',
    stableId: 'r.owner_id::text',
    versionId: 'r.deletion_generation::text',
    from: 'journal.retention_policy r',
    where: 'r.owner_id = $OWNER',
  },
  {
    entityType: 'deletion_tombstone',
    stableId: 't.entity_id::text',
    versionId: 't.id::text',
    from: 'journal.deletion_tombstone t',
    where: 't.owner_id = $OWNER',
  },
  {
    entityType: 'permanent_deletion_request',
    stableId: 'r.entity_id::text',
    versionId: 'r.id::text',
    from: 'journal.permanent_deletion_request r',
    where: 'r.owner_id = $OWNER',
  },
  {
    entityType: 'processor_installation',
    stableId: 'p.id::text',
    versionId: 'p.current_version_id::text',
    from: 'journal.processor_installation p',
  },
  {
    entityType: 'processor_version',
    stableId: 'v.processor_id::text',
    versionId: 'v.id::text',
    from: 'journal.processor_version v',
  },
  {
    entityType: 'processor_version_dependency',
    stableId:
      "d.processor_version_id::text || ':' || d.upstream_version_id::text || ':' || d.output_selector",
    versionId: 'd.upstream_version_id::text',
    from: 'journal.processor_version_dependency d',
  },
]);

function materializeSql(spec: SnapshotSpec, exportId: string, ownerId: string) {
  const sourceAlias = /^[a-z]+/.exec(spec.stableId)?.[0] ?? 'row';
  const where = (spec.where ?? 'true').replaceAll(
    '$OWNER',
    `'${ownerId}'::uuid`,
  );
  return sql.raw(`
    insert into journal.export_snapshot_item
      (export_id, entity_type, stable_id, version_id, journal_date, payload)
    select '${exportId}'::uuid, '${spec.entityType}', ${spec.stableId},
      ${spec.versionId ?? 'null'}, ${spec.journalDate ?? 'null'}, to_jsonb(${sourceAlias})
    from ${spec.from}
    where ${where}
    order by ${spec.stableId}, ${spec.versionId ?? spec.stableId}
  `);
}

/** Atomically closes snapshots that contain newly hidden owner material. */
export async function invalidateExportsForEntity(
  transaction: JournalTransaction,
  input: {
    readonly ownerId: string;
    readonly entityId: string;
    readonly now: Date;
    readonly errorCode: string;
  },
): Promise<void> {
  await transaction.execute(
    sql.raw('lock table journal.retention_policy in row exclusive mode'),
  );
  await transaction.execute(sql`
    with invalidated as (
      update journal.export_request export
      set status = 'invalidated', invalidated_at = ${input.now},
          updated_at = ${input.now}, error_code = ${input.errorCode}
      where export.owner_id = ${input.ownerId}::uuid
        and export.status in ('queued', 'running', 'completed')
        and (
          exists (
            select 1 from journal.export_snapshot_item item
            where item.export_id = export.id
              and item.stable_id = ${input.entityId}
          )
          or exists (
            select 1 from journal.export_blob_lease lease
            where lease.export_id = export.id
              and lease.entity_id = ${input.entityId}::uuid
          )
        )
      returning id
    )
    update journal.export_blob_lease lease
    set released_at = ${input.now}
    where lease.export_id in (select id from invalidated)
      and lease.released_at is null
  `);
}

export class ExportRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async createSnapshot(input: {
    readonly id: string;
    readonly ownerId: string;
    readonly includeAudio: boolean;
    readonly includeProviderRawResponses: boolean;
    readonly now: () => Date;
    readonly correlationId: string;
    readonly boss: PgBoss;
    readonly idempotencyKey: string;
  }): Promise<{ readonly row: ExportRow; readonly replayed: boolean }> {
    parseUuidV7(input.id);
    parseUuidV7(input.ownerId);
    return inTransaction(
      this.database,
      async (transaction) => {
        // Acquire the exclusion fence before PostgreSQL establishes this
        // REPEATABLE READ snapshot. Deletions take a conflicting lock, so a
        // deletion either precedes the snapshot or invalidates its export.
        await transaction.execute(
          sql.raw('lock table journal.retention_policy in share mode'),
        );
        const [existing] = await transaction
          .select()
          .from(exportRequests)
          .where(
            and(
              eq(exportRequests.ownerId, input.ownerId),
              eq(exportRequests.idempotencyKey, input.idempotencyKey),
            ),
          )
          .limit(1);
        if (existing !== undefined) {
          if (
            existing.includeAudio !== input.includeAudio ||
            existing.includeProviderRawResponses !==
              input.includeProviderRawResponses
          )
            throw new ExportConflictError(
              'The idempotency key was already used for another selection.',
            );
          return { row: existing, replayed: true };
        }
        const snapshotAt = input.now();
        const expiresAt = new Date(
          snapshotAt.getTime() + EXPORT_DOWNLOAD_TTL_MILLISECONDS,
        );
        await transaction.insert(exportRequests).values({
          id: input.id,
          ownerId: input.ownerId,
          idempotencyKey: input.idempotencyKey,
          manifestSchemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
          includeAudio: input.includeAudio,
          includeProviderRawResponses: input.includeProviderRawResponses,
          snapshotAt,
          expiresAt,
          createdAt: snapshotAt,
          updatedAt: snapshotAt,
        });
        for (const spec of SNAPSHOT_SPECS) {
          await transaction.execute(
            materializeSql(spec, input.id, input.ownerId),
          );
        }
        if (input.includeAudio) {
          await transaction.execute(sql`
            insert into journal.export_blob_lease
              (export_id, entity_id, blob_kind, blob_key, archive_path, media_type,
               byte_size, sha256, lease_expires_at)
            select ${input.id}::uuid, r.id, 'audio', r.final_blob_key,
              'audio/' || r.id::text || '/original', r.mime_type,
              r.final_byte_size, r.final_sha256, ${expiresAt}
            from journal.recording r
            join journal.contribution c on c.id = r.contribution_id
            join journal.journal_day d on d.id = c.journal_day_id
            where d.user_id = ${input.ownerId}::uuid
              and c.deleted_at is null and r.audio_deleted_at is null
              and r.persistence_state = 'durable' and r.final_blob_key is not null
          `);
        }
        if (input.includeProviderRawResponses) {
          await transaction.execute(sql`
            insert into journal.export_blob_lease
              (export_id, entity_id, blob_kind, blob_key, archive_path, media_type,
               byte_size, sha256, lease_expires_at)
            select ${input.id}::uuid, source.entity_id, 'provider_raw_response',
              source.blob_key, 'provider-raw/' || source.entity_id::text || '.json',
              source.media_type, source.byte_size, source.sha256, ${expiresAt}
            from (
              select run.raw_response_id entity_id, run.raw_response_blob_key blob_key,
                run.raw_response_media_type media_type, run.raw_response_byte_size byte_size,
                run.raw_response_sha256 sha256, d.user_id owner_id
              from journal.transcription_run run join journal.recording r on r.id=run.recording_id
              join journal.contribution c on c.id=r.contribution_id join journal.journal_day d on d.id=c.journal_day_id
              where c.deleted_at is null
              union all
              select run.raw_response_id, run.raw_response_blob_key, run.raw_response_media_type,
                run.raw_response_byte_size, run.raw_response_sha256, d.user_id
              from journal.transcript_cleanup_run run join journal.recording r on r.id=run.recording_id
              join journal.contribution c on c.id=r.contribution_id join journal.journal_day d on d.id=c.journal_day_id
              where c.deleted_at is null
              union all
              select run.raw_response_id, run.raw_response_blob_key, run.raw_response_media_type,
                run.raw_response_byte_size, run.raw_response_sha256, d.user_id
              from journal.processor_run run join journal.journal_day d on d.id=run.target_journal_day_id
              union all
              select a.raw_response_id, a.raw_response_blob_key, a.raw_response_media_type,
                a.raw_response_byte_size, a.raw_response_sha256, a.owner_id
              from journal.grounded_answer a
            ) source
            where source.owner_id = ${input.ownerId}::uuid
              and source.entity_id is not null and source.blob_key is not null
              and source.media_type is not null and source.byte_size is not null
              and source.sha256 is not null
              and not exists (
                select 1 from journal.deletion_tombstone tombstone
                where tombstone.owner_id = source.owner_id
                  and tombstone.entity_kind = 'provider_raw_response'
                  and tombstone.entity_id = source.entity_id
              )
            on conflict do nothing
          `);
        }
        const [{ count = 0 } = {}] = await transaction
          .select({ count: sql<number>`count(*)::int` })
          .from(exportSnapshotItems)
          .where(eq(exportSnapshotItems.exportId, input.id));
        const [{ count: blobs = 0 } = {}] = await transaction
          .select({ count: sql<number>`count(*)::int`.mapWith(Number) })
          .from(exportBlobLeases)
          .where(eq(exportBlobLeases.exportId, input.id));
        const [created] = await transaction
          .update(exportRequests)
          .set({
            entityCount: Number(count),
            fileCount: Number(blobs),
            updatedAt: snapshotAt,
          })
          .where(eq(exportRequests.id, input.id))
          .returning();
        await transaction.insert(auditEvents).values({
          id: createUuidV7<'audit-event'>(),
          actorId: input.ownerId,
          action: 'export.snapshot_created',
          entityType: 'export_request',
          entityId: input.id,
          correlationId: input.correlationId,
          metadata: {
            manifestSchemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
            includeAudio: input.includeAudio,
            includeProviderRawResponses: input.includeProviderRawResponses,
            entityCount: Number(count),
          },
          occurredAt: snapshotAt,
        });
        await enqueueJobInTransaction({
          boss: input.boss,
          transaction,
          queueName: queueNames.export,
          jobId: input.id,
          payload: createQueueJobPayload({
            identifiers: { exportId: input.id },
            operation: 'export',
            queueName: queueNames.export,
          }),
        });
        if (created === undefined) throw new ExportNotFoundError();
        return { row: created, replayed: false };
      },
      { isolationLevel: 'repeatable read' },
    );
  }

  public async get(
    ownerId: string,
    id: string,
  ): Promise<ExportRow | undefined> {
    const [row] = await this.database
      .select()
      .from(exportRequests)
      .where(
        and(eq(exportRequests.ownerId, ownerId), eq(exportRequests.id, id)),
      )
      .limit(1);
    return row;
  }

  public list(ownerId: string, limit = 50): Promise<ExportRow[]> {
    return this.database
      .select()
      .from(exportRequests)
      .where(eq(exportRequests.ownerId, ownerId))
      .orderBy(desc(exportRequests.createdAt), desc(exportRequests.id))
      .limit(limit);
  }

  public async recordDownload(input: {
    readonly ownerId: string;
    readonly exportId: string;
    readonly correlationId: string;
    readonly occurredAt: Date;
  }): Promise<void> {
    await this.database.insert(auditEvents).values({
      id: createUuidV7<'audit-event'>(),
      action: 'export.download_started',
      actorId: input.ownerId,
      entityType: 'export_request',
      entityId: input.exportId,
      correlationId: input.correlationId,
      metadata: {},
      occurredAt: input.occurredAt,
    });
  }

  public async claim(id: string, now: Date): Promise<ExportRow | undefined> {
    return inTransaction(this.database, async (transaction) => {
      const [row] = await transaction
        .select()
        .from(exportRequests)
        .where(eq(exportRequests.id, id))
        .for('update')
        .limit(1);
      if (row === undefined || row.status !== 'queued') return undefined;
      if (row.expiresAt <= now) {
        await transaction
          .update(exportRequests)
          .set({ status: 'expired', updatedAt: now })
          .where(eq(exportRequests.id, id));
        await transaction
          .update(exportBlobLeases)
          .set({ releasedAt: now })
          .where(
            and(
              eq(exportBlobLeases.exportId, id),
              isNull(exportBlobLeases.releasedAt),
            ),
          );
        return undefined;
      }
      const [claimed] = await transaction
        .update(exportRequests)
        .set({
          status: 'running',
          startedAt: now,
          errorCode: null,
          updatedAt: now,
        })
        .where(eq(exportRequests.id, id))
        .returning();
      return claimed;
    });
  }

  public async assertRunnable(id: string): Promise<ExportRow> {
    const [row] = await this.database
      .select()
      .from(exportRequests)
      .where(eq(exportRequests.id, id))
      .limit(1);
    if (row === undefined) throw new ExportNotFoundError();
    if (row.status !== 'running')
      throw new ExportUnavailableError(`Export is ${row.status}.`);
    return row;
  }

  public async entityTypes(
    id: string,
  ): Promise<Array<{ entityType: string; count: number }>> {
    return this.database
      .select({
        entityType: exportSnapshotItems.entityType,
        count: sql<number>`count(*)::int`.mapWith(Number),
      })
      .from(exportSnapshotItems)
      .where(eq(exportSnapshotItems.exportId, id))
      .groupBy(exportSnapshotItems.entityType)
      .orderBy(asc(exportSnapshotItems.entityType));
  }

  public jsonLineItems(
    id: string,
    entityType: string,
    after: number,
    limit = 100,
  ) {
    return this.database
      .select({
        sequence: exportSnapshotItems.sequence,
        entityType: exportSnapshotItems.entityType,
        stableId: exportSnapshotItems.stableId,
        versionId: exportSnapshotItems.versionId,
        journalDate: exportSnapshotItems.journalDate,
        // Preserve PostgreSQL numeric JSON tokens exactly instead of parsing
        // potentially unbounded byte/duration values through JavaScript Number.
        payloadJson: sql<string>`${exportSnapshotItems.payload}::text`,
      })
      .from(exportSnapshotItems)
      .where(
        and(
          eq(exportSnapshotItems.exportId, id),
          eq(exportSnapshotItems.entityType, entityType),
          gt(exportSnapshotItems.sequence, after),
        ),
      )
      .orderBy(asc(exportSnapshotItems.sequence))
      .limit(limit);
  }

  public async journalDates(
    id: string,
    after: string,
    limit = 100,
  ): Promise<string[]> {
    const rows = await this.database
      .selectDistinct({ journalDate: exportSnapshotItems.journalDate })
      .from(exportSnapshotItems)
      .where(
        and(
          eq(exportSnapshotItems.exportId, id),
          sql`${exportSnapshotItems.journalDate} is not null`,
          gt(exportSnapshotItems.journalDate, after),
        ),
      )
      .orderBy(asc(exportSnapshotItems.journalDate))
      .limit(limit);
    return rows.flatMap(({ journalDate }) =>
      journalDate === null ? [] : [journalDate],
    );
  }

  public markdownItems(
    id: string,
    journalDate: string,
    after: number,
    limit = 100,
  ) {
    return this.database
      .select()
      .from(exportSnapshotItems)
      .where(
        and(
          eq(exportSnapshotItems.exportId, id),
          eq(exportSnapshotItems.journalDate, journalDate),
          gt(exportSnapshotItems.sequence, after),
          inArray(exportSnapshotItems.entityType, [
            'journal_day',
            'contribution',
            'contribution_revision',
            'transcript',
            'transcript_revision',
            'processor_artifact',
            'processor_artifact_version',
          ]),
        ),
      )
      .orderBy(asc(exportSnapshotItems.sequence))
      .limit(limit);
  }

  public blobLeases(
    id: string,
    afterPath: string,
    limit = 100,
  ): Promise<ExportBlobLeaseRow[]> {
    return this.database
      .select()
      .from(exportBlobLeases)
      .where(
        and(
          eq(exportBlobLeases.exportId, id),
          isNull(exportBlobLeases.releasedAt),
          gt(exportBlobLeases.archivePath, afterPath),
        ),
      )
      .orderBy(asc(exportBlobLeases.archivePath))
      .limit(limit);
  }

  public async complete(
    id: string,
    blob: { key: string; byteSize: bigint; sha256: string },
    fileCount: number,
    now: Date,
  ): Promise<boolean> {
    return inTransaction(this.database, async (transaction) => {
      const [updated] = await transaction
        .update(exportRequests)
        .set({
          status: 'completed',
          archiveBlobKey: blob.key,
          archiveByteSize: blob.byteSize,
          archiveSha256: blob.sha256,
          completedAt: now,
          fileCount,
          updatedAt: now,
        })
        .where(
          and(eq(exportRequests.id, id), eq(exportRequests.status, 'running')),
        )
        .returning({ id: exportRequests.id });
      await transaction
        .update(exportBlobLeases)
        .set({ releasedAt: now })
        .where(eq(exportBlobLeases.exportId, id));
      return updated !== undefined;
    });
  }

  public async fail(id: string, errorCode: string, now: Date): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const [failed] = await transaction
        .update(exportRequests)
        .set({ status: 'failed', errorCode, updatedAt: now })
        .where(
          and(
            eq(exportRequests.id, id),
            inArray(exportRequests.status, ['queued', 'running']),
          ),
        )
        .returning({ id: exportRequests.id });
      if (failed === undefined) return;
      await transaction
        .update(exportBlobLeases)
        .set({ releasedAt: now })
        .where(
          and(
            eq(exportBlobLeases.exportId, id),
            isNull(exportBlobLeases.releasedAt),
          ),
        );
    });
  }

  /**
   * Atomically closes due downloads before returning their hosted blob keys.
   * Rows with a retained key remain discoverable until object deletion succeeds,
   * which makes cleanup safely retryable after a worker or adapter failure.
   */
  public async expireDue(
    now: Date,
    limit = 100,
  ): Promise<ExpiredExportArchive[]> {
    return inTransaction(this.database, async (transaction) => {
      const due = await transaction
        .select({
          id: exportRequests.id,
          archiveBlobKey: exportRequests.archiveBlobKey,
        })
        .from(exportRequests)
        .where(
          sql`(${exportRequests.expiresAt} <= ${now} and ${exportRequests.status} in ('queued', 'running', 'completed'))
            or (${exportRequests.status} in ('expired', 'invalidated', 'failed') and ${exportRequests.archiveBlobKey} is not null)`,
        )
        .orderBy(asc(exportRequests.expiresAt), asc(exportRequests.id))
        .limit(limit)
        .for('update', { skipLocked: true });
      if (due.length === 0) return [];
      const ids = due.map(({ id }) => id);
      await transaction
        .update(exportRequests)
        .set({ status: 'expired', updatedAt: now })
        .where(
          and(
            inArray(exportRequests.id, ids),
            inArray(exportRequests.status, ['queued', 'running', 'completed']),
          ),
        );
      await transaction
        .update(exportBlobLeases)
        .set({ releasedAt: now })
        .where(
          and(
            inArray(exportBlobLeases.exportId, ids),
            isNull(exportBlobLeases.releasedAt),
          ),
        );
      return due;
    });
  }

  public async markHostedArchiveDeleted(
    id: string,
    archiveBlobKey: string,
    now: Date,
  ): Promise<void> {
    await this.database
      .update(exportRequests)
      .set({ archiveBlobKey: null, updatedAt: now })
      .where(
        and(
          eq(exportRequests.id, id),
          inArray(exportRequests.status, ['expired', 'invalidated', 'failed']),
          eq(exportRequests.archiveBlobKey, archiveBlobKey),
        ),
      );
  }
}
