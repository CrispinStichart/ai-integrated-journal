import {
  createUuidV7,
  deletionEligibleAt,
  retentionMatrix,
  type RetentionEntityKind,
} from '@journal/domain';
import { and, asc, eq, gt, lte, sql } from 'drizzle-orm';

import type {
  JournalDatabase,
  JournalTransaction,
  RepositoryContext,
} from './client.js';
import {
  auditEvents,
  contributions,
  deletionTombstones,
  journalDays,
  permanentDeletionRequests,
  recordings,
  retentionBlobCleanupItems,
  retentionPolicies,
  users,
} from './schema.js';
import { inTransaction } from './transaction.js';

const BACKUP_WARNING =
  'No backup repository is configured, so no verified post-deletion restore checkpoint can be committed.';
const CLAIM_LEASE_MILLISECONDS = 15 * 60 * 1_000;

export class RetentionNotFoundError extends Error {
  override readonly name = 'RetentionNotFoundError';
}

export class RetentionConflictError extends Error {
  override readonly name = 'RetentionConflictError';
}

export interface RetentionPreviewRecord {
  readonly entityKind: RetentionEntityKind;
  readonly entityId: string;
  readonly softDeletedAt: Date;
  readonly eligibleAt: Date;
  readonly affectedContributionCount: number;
  readonly affectedRecordingCount: number;
}

type DeletionRow = typeof permanentDeletionRequests.$inferSelect;

export class RetentionRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async preview(
    ownerId: string,
    entityKind: RetentionEntityKind,
    entityId: string,
    now = new Date(),
  ): Promise<RetentionPreviewRecord & { readonly eligible: boolean }> {
    const policy = await this.policy(ownerId);
    const record = await previewTarget(
      this.database,
      ownerId,
      entityKind,
      entityId,
      policy.materialGraceDays,
      policy.audioGraceDays,
    );
    return { ...record, eligible: record.eligibleAt <= now };
  }

  public async request(input: {
    readonly id: string;
    readonly tombstoneId: string;
    readonly ownerId: string;
    readonly entityKind: RetentionEntityKind;
    readonly entityId: string;
    readonly correlationId: string;
    readonly requestedAt: Date;
  }): Promise<{ readonly deletion: DeletionRow; readonly replayed: boolean }> {
    return inTransaction(this.database, async (transaction) => {
      const [existing] = await transaction
        .select()
        .from(permanentDeletionRequests)
        .where(
          and(
            eq(permanentDeletionRequests.ownerId, input.ownerId),
            eq(permanentDeletionRequests.entityKind, input.entityKind),
            eq(permanentDeletionRequests.entityId, input.entityId),
          ),
        )
        .limit(1);
      if (existing !== undefined) return { deletion: existing, replayed: true };

      const policy = await lockPolicy(transaction, input.ownerId);
      const preview = await previewTarget(
        transaction,
        input.ownerId,
        input.entityKind,
        input.entityId,
        policy.materialGraceDays,
        policy.audioGraceDays,
      );
      if (preview.eligibleAt > input.requestedAt) {
        throw new RetentionConflictError(
          'The recoverable deletion grace period has not elapsed.',
        );
      }
      const childTargets =
        input.entityKind === 'journal_day'
          ? await transaction
              .select({
                contributionId: contributions.id,
                recordingId: recordings.id,
              })
              .from(contributions)
              .leftJoin(
                recordings,
                eq(recordings.contributionId, contributions.id),
              )
              .where(eq(contributions.journalDayId, input.entityId))
          : [];
      const secondaryTargets = childTargets.flatMap((target) => [
        {
          entityKind: 'contribution' as const,
          entityId: target.contributionId,
        },
        ...(target.recordingId === null
          ? []
          : [
              {
                entityKind: 'recording_audio' as const,
                entityId: target.recordingId,
              },
            ]),
      ]);
      const generation = policy.deletionGeneration + 1;
      await transaction
        .update(retentionPolicies)
        .set({
          deletionGeneration: generation + secondaryTargets.length,
          updatedAt: input.requestedAt,
        })
        .where(eq(retentionPolicies.ownerId, input.ownerId));
      await transaction.insert(deletionTombstones).values({
        id: input.tombstoneId,
        ownerId: input.ownerId,
        entityKind: input.entityKind,
        entityId: input.entityId,
        deletedAt: input.requestedAt,
        generation,
        correlationId: input.correlationId,
        createdAt: input.requestedAt,
      });
      if (secondaryTargets.length > 0) {
        await transaction.insert(deletionTombstones).values(
          secondaryTargets.map((target, index) => ({
            id: createUuidV7<'deletion-tombstone'>(),
            ownerId: input.ownerId,
            ...target,
            deletedAt: input.requestedAt,
            generation: generation + index + 1,
            correlationId: input.correlationId,
            createdAt: input.requestedAt,
          })),
        );
      }
      const [deletion] = await transaction
        .insert(permanentDeletionRequests)
        .values({
          id: input.id,
          ownerId: input.ownerId,
          entityKind: input.entityKind,
          entityId: input.entityId,
          tombstoneId: input.tombstoneId,
          generation,
          eligibleAt: preview.eligibleAt,
          requestedAt: input.requestedAt,
          backupCheckpoint: 'not_configured',
          updatedAt: input.requestedAt,
        })
        .returning();
      if (deletion === undefined) throw new RetentionConflictError();
      await captureBlobKeys(transaction, deletion);
      await transaction.insert(auditEvents).values({
        id: input.correlationId,
        action: 'retention.permanent_deletion_requested',
        actorId: input.ownerId,
        entityType: 'permanent_deletion_request',
        entityId: deletion.id,
        correlationId: input.correlationId,
        metadata: {
          entityKind: input.entityKind,
          generation,
          backupCheckpoint: 'not_configured',
        },
        occurredAt: input.requestedAt,
      });
      return { deletion, replayed: false };
    });
  }

  public async get(
    ownerId: string,
    id: string,
  ): Promise<DeletionRow | undefined> {
    const [row] = await this.database
      .select()
      .from(permanentDeletionRequests)
      .where(
        and(
          eq(permanentDeletionRequests.id, id),
          eq(permanentDeletionRequests.ownerId, ownerId),
        ),
      )
      .limit(1);
    return row;
  }

  public async tombstones(
    ownerId: string,
    afterGeneration: number,
    limit: number,
  ) {
    const rows = await this.database
      .select()
      .from(deletionTombstones)
      .where(
        and(
          eq(deletionTombstones.ownerId, ownerId),
          gt(deletionTombstones.generation, afterGeneration),
        ),
      )
      .orderBy(asc(deletionTombstones.generation))
      .limit(limit + 1);
    const latest = await this.policy(ownerId);
    return {
      items: rows.slice(0, limit),
      hasMore: rows.length > limit,
      latestGeneration: latest.deletionGeneration,
    };
  }

  public async acknowledgeBrowserPurge(
    ownerId: string,
    generation: number,
  ): Promise<void> {
    await this.database
      .update(permanentDeletionRequests)
      .set({ browserPurgeAcknowledged: true, updatedAt: new Date() })
      .where(
        and(
          eq(permanentDeletionRequests.ownerId, ownerId),
          lte(permanentDeletionRequests.generation, generation),
        ),
      );
  }

  public async expiredRawResponses(now: Date, limit = 100) {
    const result = await this.database.execute(sql`
      select source.owner_id, source.raw_response_id
      from (
        select day.user_id as owner_id, run.raw_response_id, run.raw_response_expires_at, run.raw_response_blob_key
        from journal.transcription_run run
        join journal.recording recording on recording.id = run.recording_id
        join journal.contribution contribution on contribution.id = recording.contribution_id
        join journal.journal_day day on day.id = contribution.journal_day_id
        union all
        select day.user_id, run.raw_response_id, run.raw_response_expires_at, run.raw_response_blob_key
        from journal.transcript_cleanup_run run
        join journal.recording recording on recording.id = run.recording_id
        join journal.contribution contribution on contribution.id = recording.contribution_id
        join journal.journal_day day on day.id = contribution.journal_day_id
        union all
        select day.user_id, run.raw_response_id, run.raw_response_expires_at, run.raw_response_blob_key
        from journal.processor_run run
        join journal.journal_day day on day.id = run.target_journal_day_id
        union all
        select answer.owner_id, answer.raw_response_id, answer.raw_response_expires_at, answer.raw_response_blob_key
        from journal.grounded_answer answer
      ) source
      where source.raw_response_id is not null
        and source.raw_response_blob_key is not null
        and source.raw_response_expires_at <= ${now}
        and not exists (
          select 1 from journal.deletion_tombstone tombstone
          where tombstone.owner_id = source.owner_id
            and tombstone.entity_kind = 'provider_raw_response'
            and tombstone.entity_id = source.raw_response_id
        )
      order by source.raw_response_expires_at, source.raw_response_id
      limit ${limit}
    `);
    return result.rows.flatMap((row) =>
      typeof row.owner_id === 'string' &&
      typeof row.raw_response_id === 'string'
        ? [{ ownerId: row.owner_id, entityId: row.raw_response_id }]
        : [],
    );
  }

  /** Claims one bounded unit with SKIP LOCKED so retries and parallel workers are safe. */
  public async claim(
    now: Date,
    requestId?: string,
  ): Promise<DeletionRow | undefined> {
    return inTransaction(this.database, async (transaction) => {
      const [row] = await transaction
        .select()
        .from(permanentDeletionRequests)
        .where(
          and(
            inStatusClaimable(now),
            lte(permanentDeletionRequests.eligibleAt, now),
            requestId === undefined
              ? undefined
              : eq(permanentDeletionRequests.id, requestId),
          ),
        )
        .orderBy(
          asc(permanentDeletionRequests.eligibleAt),
          asc(permanentDeletionRequests.id),
        )
        .for('update', { skipLocked: true })
        .limit(1);
      if (row === undefined) return undefined;
      const [claimed] = await transaction
        .update(permanentDeletionRequests)
        .set({
          status: 'purging',
          startedAt: row.startedAt ?? now,
          attempts: row.attempts + 1,
          errorCode: null,
          updatedAt: now,
        })
        .where(eq(permanentDeletionRequests.id, row.id))
        .returning();
      return claimed;
    });
  }

  public async blobItems(requestId: string) {
    return this.database
      .select()
      .from(retentionBlobCleanupItems)
      .where(
        and(
          eq(retentionBlobCleanupItems.requestId, requestId),
          eq(retentionBlobCleanupItems.status, 'pending'),
        ),
      )
      .orderBy(asc(retentionBlobCleanupItems.blobKey))
      .limit(128);
  }

  public async markBlobDeleted(requestId: string, blobKey: string, now: Date) {
    await this.database
      .update(retentionBlobCleanupItems)
      .set({
        status: 'deleted',
        attempts: sql`${retentionBlobCleanupItems.attempts} + 1`,
        lastErrorCode: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(retentionBlobCleanupItems.requestId, requestId),
          eq(retentionBlobCleanupItems.blobKey, blobKey),
        ),
      );
  }

  public async markFailed(requestId: string, errorCode: string, now: Date) {
    await this.database
      .update(permanentDeletionRequests)
      .set({ status: 'failed', errorCode, updatedAt: now })
      .where(eq(permanentDeletionRequests.id, requestId));
  }

  public async complete(requestId: string, now: Date): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const [request] = await transaction
        .select()
        .from(permanentDeletionRequests)
        .where(eq(permanentDeletionRequests.id, requestId))
        .for('update')
        .limit(1);
      if (request === undefined) throw new RetentionNotFoundError();
      if (request.status === 'completed') return;
      const [remaining] = await transaction
        .select({ blobKey: retentionBlobCleanupItems.blobKey })
        .from(retentionBlobCleanupItems)
        .where(
          and(
            eq(retentionBlobCleanupItems.requestId, requestId),
            eq(retentionBlobCleanupItems.status, 'pending'),
          ),
        )
        .limit(1);
      if (remaining !== undefined)
        throw new RetentionConflictError('Blob cleanup is incomplete.');

      if (request.entityKind === 'contribution') {
        await transaction.execute(
          sql`select journal.purge_contribution(${request.ownerId}::uuid, ${request.entityId}::uuid)`,
        );
      } else if (request.entityKind === 'journal_day') {
        await transaction.execute(
          sql`select journal.purge_journal_day(${request.ownerId}::uuid, ${request.entityId}::uuid)`,
        );
      } else if (request.entityKind === 'recording_audio') {
        await transaction.execute(
          sql`select journal.purge_recording_audio(${request.ownerId}::uuid, ${request.entityId}::uuid, ${now})`,
        );
      } else {
        await transaction.execute(
          sql`select journal.purge_provider_raw_response(${request.ownerId}::uuid, ${request.entityId}::uuid)`,
        );
      }

      await transaction
        .delete(retentionBlobCleanupItems)
        .where(eq(retentionBlobCleanupItems.requestId, requestId));
      await transaction
        .update(permanentDeletionRequests)
        .set({
          status: 'completed',
          completedAt: now,
          errorCode: null,
          updatedAt: now,
        })
        .where(eq(permanentDeletionRequests.id, requestId));
      await transaction.insert(auditEvents).values({
        id: request.tombstoneId,
        action: 'retention.permanent_deletion_completed',
        actorId: request.ownerId,
        entityType: 'permanent_deletion_request',
        entityId: request.id,
        correlationId: request.tombstoneId,
        metadata: {
          entityKind: request.entityKind,
          generation: request.generation,
          backupCheckpoint: request.backupCheckpoint,
        },
        occurredAt: now,
      });
    });
  }

  private async policy(ownerId: string) {
    const [owner] = await this.database
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (owner === undefined) throw new RetentionNotFoundError();
    await this.database
      .insert(retentionPolicies)
      .values({ ownerId })
      .onConflictDoNothing();
    const [policy] = await this.database
      .select()
      .from(retentionPolicies)
      .where(eq(retentionPolicies.ownerId, ownerId))
      .limit(1);
    if (policy === undefined) throw new RetentionConflictError();
    return policy;
  }
}

async function lockPolicy(transaction: JournalTransaction, ownerId: string) {
  await transaction
    .insert(retentionPolicies)
    .values({ ownerId })
    .onConflictDoNothing();
  const [policy] = await transaction
    .select()
    .from(retentionPolicies)
    .where(eq(retentionPolicies.ownerId, ownerId))
    .for('update')
    .limit(1);
  if (policy === undefined) throw new RetentionConflictError();
  return policy;
}

async function previewTarget(
  context: RepositoryContext,
  ownerId: string,
  entityKind: RetentionEntityKind,
  entityId: string,
  materialGraceDays: number,
  audioGraceDays: number,
): Promise<RetentionPreviewRecord> {
  if (entityKind === 'contribution') {
    const [row] = await context
      .select({
        deletedAt: contributions.deletedAt,
        recordingId: recordings.id,
      })
      .from(contributions)
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .leftJoin(recordings, eq(recordings.contributionId, contributions.id))
      .where(
        and(eq(contributions.id, entityId), eq(journalDays.userId, ownerId)),
      )
      .limit(1);
    if (row === undefined) throw new RetentionNotFoundError();
    if (row.deletedAt === null)
      throw new RetentionConflictError(
        'The contribution must be recoverably deleted first.',
      );
    return {
      entityKind,
      entityId,
      softDeletedAt: row.deletedAt,
      eligibleAt: deletionEligibleAt(row.deletedAt, materialGraceDays),
      affectedContributionCount: 1,
      affectedRecordingCount: row.recordingId === null ? 0 : 1,
    };
  }
  if (entityKind === 'recording_audio') {
    const [row] = await context
      .select({ deletedAt: recordings.audioDeletedAt })
      .from(recordings)
      .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(and(eq(recordings.id, entityId), eq(journalDays.userId, ownerId)))
      .limit(1);
    if (row === undefined) throw new RetentionNotFoundError();
    if (row.deletedAt === null)
      throw new RetentionConflictError(
        'The audio must be recoverably deleted first.',
      );
    return {
      entityKind,
      entityId,
      softDeletedAt: row.deletedAt,
      eligibleAt: deletionEligibleAt(row.deletedAt, audioGraceDays),
      affectedContributionCount: 0,
      affectedRecordingCount: 1,
    };
  }
  if (entityKind === 'journal_day') {
    const rows = await context
      .select({
        contributionId: contributions.id,
        deletedAt: contributions.deletedAt,
        recordingId: recordings.id,
      })
      .from(journalDays)
      .leftJoin(contributions, eq(contributions.journalDayId, journalDays.id))
      .leftJoin(recordings, eq(recordings.contributionId, contributions.id))
      .where(
        and(eq(journalDays.id, entityId), eq(journalDays.userId, ownerId)),
      );
    if (rows.length === 0) throw new RetentionNotFoundError();
    const material = rows.filter((row) => row.contributionId !== null);
    if (material.length === 0 || material.some((row) => row.deletedAt === null))
      throw new RetentionConflictError(
        'Every Journal Day contribution must be recoverably deleted first.',
      );
    const softDeletedAt = new Date(
      Math.max(...material.map((row) => row.deletedAt?.getTime() ?? 0)),
    );
    return {
      entityKind,
      entityId,
      softDeletedAt,
      eligibleAt: deletionEligibleAt(softDeletedAt, materialGraceDays),
      affectedContributionCount: material.length,
      affectedRecordingCount: material.filter((row) => row.recordingId !== null)
        .length,
    };
  }
  const result = await context.execute(sql<{
    expires_at: Date;
  }>`
    select source.expires_at
    from (
      select tr.raw_response_id, tr.raw_response_expires_at as expires_at, jd.user_id
      from journal.transcription_run tr
      join journal.recording r on r.id = tr.recording_id
      join journal.contribution c on c.id = r.contribution_id
      join journal.journal_day jd on jd.id = c.journal_day_id
      union all
      select cr.raw_response_id, cr.raw_response_expires_at, jd.user_id
      from journal.transcript_cleanup_run cr
      join journal.recording r on r.id = cr.recording_id
      join journal.contribution c on c.id = r.contribution_id
      join journal.journal_day jd on jd.id = c.journal_day_id
      union all
      select pr.raw_response_id, pr.raw_response_expires_at, jd.user_id
      from journal.processor_run pr
      join journal.journal_day jd on jd.id = pr.target_journal_day_id
      union all
      select ga.raw_response_id, ga.raw_response_expires_at, ga.owner_id
      from journal.grounded_answer ga
    ) source
    where source.raw_response_id = ${entityId}::uuid and source.user_id = ${ownerId}::uuid
    limit 1
  `);
  const row = result.rows[0];
  if (row === undefined || row.expires_at === null)
    throw new RetentionNotFoundError();
  if (!(row.expires_at instanceof Date) && typeof row.expires_at !== 'string')
    throw new RetentionConflictError(
      'Raw-response expiry metadata is invalid.',
    );
  const expiresAt = new Date(row.expires_at);
  return {
    entityKind,
    entityId,
    softDeletedAt: expiresAt,
    eligibleAt: expiresAt,
    affectedContributionCount: 0,
    affectedRecordingCount: 0,
  };
}

async function captureBlobKeys(
  transaction: JournalTransaction,
  deletion: DeletionRow,
): Promise<void> {
  const items: Array<typeof retentionBlobCleanupItems.$inferInsert> = [];
  if (
    deletion.entityKind === 'contribution' ||
    deletion.entityKind === 'journal_day'
  ) {
    const predicate =
      deletion.entityKind === 'contribution'
        ? sql`contribution.id = ${deletion.entityId}::uuid`
        : sql`contribution.journal_day_id = ${deletion.entityId}::uuid`;
    await transaction.execute(sql`
      insert into journal.retention_blob_cleanup_item(request_id, blob_key, blob_kind)
      select ${deletion.id}::uuid, recording.final_blob_key, 'final_audio'::retention_blob_kind
      from journal.contribution contribution
      join journal.recording recording on recording.contribution_id = contribution.id
      where ${predicate} and recording.final_blob_key is not null
      union all
      select ${deletion.id}::uuid, chunk.staging_blob_key, 'staging_chunk'::retention_blob_kind
      from journal.contribution contribution
      join journal.recording recording on recording.contribution_id = contribution.id
      join journal.recording_upload upload on upload.recording_id = recording.id
      join journal.recording_chunk chunk on chunk.upload_id = upload.id
      where ${predicate}
      on conflict do nothing
    `);
    await transaction.execute(sql`
      with recursive source_contributions(id) as (
        select contribution.id
        from journal.contribution contribution
        where ${predicate}
      ), source_recordings(id) as (
        select recording.id
        from journal.recording recording
        where recording.contribution_id in (select id from source_contributions)
      ), affected_runs(id) as (
        select run.id
        from journal.processor_run run
        where run.target_contribution_id in (select id from source_contributions)
           or (${deletion.entityKind === 'journal_day'} and run.target_journal_day_id = ${deletion.entityId}::uuid)
        union
        select input.run_id
        from journal.processor_run_input input
        join journal.contribution_revision revision
          on revision.id = input.contribution_revision_id
        where revision.contribution_id in (select id from source_contributions)
        union
        select input.run_id
        from journal.processor_run_input input
        join journal.transcript_revision revision
          on revision.id = input.transcript_revision_id
        join journal.transcript transcript on transcript.id = revision.transcript_id
        where transcript.recording_id in (select id from source_recordings)
        union
        select downstream.run_id
        from journal.processor_run_input downstream
        join journal.processor_result result
          on result.id = downstream.processor_result_id
        join affected_runs upstream on upstream.id = result.run_id
      ), affected_artifacts(id) as (
        select artifact.id
        from journal.processor_artifact artifact
        where artifact.target_contribution_id in (select id from source_contributions)
           or (${deletion.entityKind === 'journal_day'} and artifact.target_journal_day_id = ${deletion.entityId}::uuid)
        union
        select version.artifact_id
        from journal.processor_artifact_version version
        where version.run_id in (select id from affected_runs)
      ), affected_fragments(id) as (
        select fragment.id
        from journal.search_fragment fragment
        where fragment.contribution_id in (select id from source_contributions)
           or fragment.transcript_id in (
             select transcript.id from journal.transcript transcript
             where transcript.recording_id in (select id from source_recordings)
           )
           or fragment.artifact_id in (select id from affected_artifacts)
      ), affected_answers(id) as (
        select distinct citation.answer_id
        from journal.grounded_answer_citation citation
        where citation.fragment_id in (select id from affected_fragments)
      )
      insert into journal.retention_blob_cleanup_item(request_id, blob_key, blob_kind)
      select ${deletion.id}::uuid, run.raw_response_blob_key, 'provider_raw_response'::retention_blob_kind
      from journal.transcription_run run
      where run.recording_id in (select id from source_recordings)
        and run.raw_response_blob_key is not null
      union
      select ${deletion.id}::uuid, run.raw_response_blob_key, 'provider_raw_response'::retention_blob_kind
      from journal.transcript_cleanup_run run
      where run.recording_id in (select id from source_recordings)
        and run.raw_response_blob_key is not null
      union
      select ${deletion.id}::uuid, run.raw_response_blob_key, 'provider_raw_response'::retention_blob_kind
      from journal.processor_run run
      where run.id in (select id from affected_runs)
        and run.raw_response_blob_key is not null
      union
      select ${deletion.id}::uuid, answer.raw_response_blob_key, 'provider_raw_response'::retention_blob_kind
      from journal.grounded_answer answer
      where answer.id in (select id from affected_answers)
        and answer.raw_response_blob_key is not null
      on conflict do nothing
    `);
  } else if (deletion.entityKind === 'recording_audio') {
    await transaction.execute(sql`
      insert into journal.retention_blob_cleanup_item(request_id, blob_key, blob_kind)
      select ${deletion.id}::uuid, recording.final_blob_key, 'final_audio'::retention_blob_kind
      from journal.recording recording
      where recording.id = ${deletion.entityId}::uuid and recording.final_blob_key is not null
      union all
      select ${deletion.id}::uuid, chunk.staging_blob_key, 'staging_chunk'::retention_blob_kind
      from journal.recording recording
      join journal.recording_upload upload on upload.recording_id = recording.id
      join journal.recording_chunk chunk on chunk.upload_id = upload.id
      where recording.id = ${deletion.entityId}::uuid
      on conflict do nothing
    `);
  } else {
    const result = await transaction.execute(sql<{ blob_key: string }>`
      select blob_key from (
        select raw_response_id, raw_response_blob_key as blob_key from journal.transcription_run
        union all select raw_response_id, raw_response_blob_key from journal.transcript_cleanup_run
        union all select raw_response_id, raw_response_blob_key from journal.processor_run
        union all select raw_response_id, raw_response_blob_key from journal.grounded_answer
      ) raw where raw_response_id = ${deletion.entityId}::uuid and blob_key is not null
    `);
    for (const row of result.rows) {
      if (typeof row.blob_key !== 'string') continue;
      items.push({
        requestId: deletion.id,
        blobKey: row.blob_key,
        blobKind: 'provider_raw_response',
      });
    }
  }
  if (items.length > 0) {
    await transaction
      .insert(retentionBlobCleanupItems)
      .values([...new Map(items.map((item) => [item.blobKey, item])).values()]);
  }
}

export const retentionImpactDetails = Object.freeze(
  Object.fromEntries(
    Object.entries(retentionMatrix.contribution).map(([facet, action]) => [
      facet,
      `${action === 'retain_metadata' ? 'Retain content-free' : action === 'retain' ? 'Retain unaffected' : action === 'invalidate' ? 'Invalidate' : 'Delete'} ${facet.replaceAll('_', ' ')}.`,
    ]),
  ),
);

export { BACKUP_WARNING };

function inStatusClaimable(now: Date) {
  const staleBefore = new Date(now.getTime() - CLAIM_LEASE_MILLISECONDS);
  return sql`(${permanentDeletionRequests.status} in ('pending', 'failed') or (${permanentDeletionRequests.status} = 'purging' and ${permanentDeletionRequests.updatedAt} <= ${staleBefore}))`;
}
