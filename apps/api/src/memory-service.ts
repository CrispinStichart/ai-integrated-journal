import { createHash } from 'node:crypto';

import type {
  CreateFeedbackRequest,
  FeedbackResource,
  MemoryMutationRequest,
  MemoryResource,
} from '@journal/contracts';
import {
  auditEvents,
  contributions,
  feedback,
  inTransaction,
  invalidateExportsForEntity,
  journalDays,
  memories,
  memoryApiIdempotency,
  memoryRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorResults,
  recordings,
  transcriptRevisions,
  transcripts,
  type JournalDatabase,
  type RepositoryContext,
} from '@journal/database';
import {
  classifyFeedbackScope,
  createUuidV7,
  DomainInvariantError,
  type FeedbackScope,
} from '@journal/domain';
import { and, asc, desc, eq, gt, ilike, or, sql } from 'drizzle-orm';

export class MemoryNotFoundError extends Error {
  public constructor() {
    super('Memory or feedback target not found.');
    this.name = 'MemoryNotFoundError';
  }
}

export class MemoryConflictError extends Error {
  public constructor(message = 'The memory has changed.') {
    super(message);
    this.name = 'MemoryConflictError';
  }
}

type MemoryRow = typeof memories.$inferSelect;
type MemoryRevisionRow = typeof memoryRevisions.$inferSelect;

export interface MemoryService {
  list(
    ownerId: string,
    query: Readonly<{
      q?: string;
      limit: number;
      cursor?: string;
      includeDisabled?: boolean;
      includeDeleted?: boolean;
    }>,
  ): Promise<
    Readonly<{ items: readonly MemoryResource[]; nextCursor?: string }>
  >;
  get(ownerId: string, memoryId: string): Promise<MemoryResource>;
  createFeedback(
    ownerId: string,
    input: CreateFeedbackRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<
    Readonly<{
      feedback: FeedbackResource;
      memory?: MemoryResource;
      replayed: boolean;
    }>
  >;
  mutate(
    ownerId: string,
    memoryId: string,
    expectedRevision: number,
    input: MemoryMutationRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ memory: MemoryResource; replayed: boolean }>>;
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function mapRevision(row: MemoryRevisionRow) {
  return {
    id: row.id,
    revision: row.revision,
    type: row.type,
    content: row.content,
    rationale: row.rationale,
    creator: row.creator,
    approvalState: row.approvalState,
    scope: row.scope as MemoryResource['currentRevision']['scope'],
    enabled: row.enabled,
    ...(row.deletedAt === null
      ? {}
      : { deletedAt: row.deletedAt.toISOString() }),
    createdAt: row.createdAt.toISOString(),
  };
}

async function mapMemory(
  context: RepositoryContext,
  memory: MemoryRow,
): Promise<MemoryResource> {
  const historyRows = await context
    .select()
    .from(memoryRevisions)
    .where(eq(memoryRevisions.memoryId, memory.id))
    .orderBy(desc(memoryRevisions.revision))
    .limit(51);
  const current = historyRows.find(
    (row) => row.id === memory.currentRevisionId,
  );
  if (current === undefined)
    throw new MemoryConflictError('Memory history is incomplete.');
  return {
    id: memory.id,
    revision: memory.currentRevision,
    currentRevision: mapRevision(current),
    history: historyRows.slice(0, 50).map(mapRevision),
    historyTruncated: historyRows.length > 50,
    createdAt: memory.createdAt.toISOString(),
    updatedAt: memory.updatedAt.toISOString(),
  };
}

async function ownedMemory(
  context: RepositoryContext,
  ownerId: string,
  memoryId: string,
  lock = false,
): Promise<MemoryRow> {
  const query = context
    .select()
    .from(memories)
    .where(and(eq(memories.id, memoryId), eq(memories.ownerId, ownerId)))
    .limit(1);
  const [row] = lock ? await query.for('update') : await query;
  if (row === undefined) throw new MemoryNotFoundError();
  return row;
}

async function assertOwnedTarget(
  context: RepositoryContext,
  ownerId: string,
  target: CreateFeedbackRequest['target'],
): Promise<void> {
  if (target.kind === 'transcript_revision') {
    const [row] = await context
      .select({ id: transcriptRevisions.id })
      .from(transcriptRevisions)
      .innerJoin(
        transcripts,
        eq(transcripts.id, transcriptRevisions.transcriptId),
      )
      .innerJoin(recordings, eq(recordings.id, transcripts.recordingId))
      .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(
        and(
          eq(transcriptRevisions.id, target.id),
          eq(journalDays.userId, ownerId),
        ),
      )
      .limit(1);
    if (row === undefined) throw new MemoryNotFoundError();
    return;
  }
  if (target.kind === 'artifact_version') {
    const [row] = await context
      .select({ id: processorArtifactVersions.id })
      .from(processorArtifactVersions)
      .innerJoin(
        processorArtifacts,
        eq(processorArtifacts.id, processorArtifactVersions.artifactId),
      )
      .innerJoin(
        journalDays,
        eq(journalDays.id, processorArtifacts.targetJournalDayId),
      )
      .where(
        and(
          eq(processorArtifactVersions.id, target.id),
          eq(journalDays.userId, ownerId),
        ),
      )
      .limit(1);
    if (row === undefined) throw new MemoryNotFoundError();
    return;
  }
  const [row] = await context
    .select({ id: processorResults.id })
    .from(processorResults)
    .innerJoin(
      journalDays,
      eq(journalDays.id, processorResults.targetJournalDayId),
    )
    .where(
      and(eq(processorResults.id, target.id), eq(journalDays.userId, ownerId)),
    )
    .limit(1);
  if (row === undefined) throw new MemoryNotFoundError();
}

async function readLedger(
  context: RepositoryContext,
  ownerId: string,
  operation: string,
  key: string,
  requestHash: string,
) {
  const [row] = await context
    .select()
    .from(memoryApiIdempotency)
    .where(
      and(
        eq(memoryApiIdempotency.ownerId, ownerId),
        eq(memoryApiIdempotency.operation, operation),
        eq(memoryApiIdempotency.idempotencyKey, key),
      ),
    )
    .limit(1);
  if (row !== undefined && row.requestHash !== requestHash) {
    throw new MemoryConflictError(
      'The idempotency key was reused with different input.',
    );
  }
  return row;
}

export class PostgresMemoryService implements MemoryService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async list(
    ownerId: string,
    query: Parameters<MemoryService['list']>[1],
  ) {
    const conditions = [eq(memories.ownerId, ownerId)];
    if (query.cursor !== undefined)
      conditions.push(gt(memories.id, query.cursor));
    if (query.includeDisabled !== true)
      conditions.push(eq(memories.enabled, true));
    if (query.includeDeleted !== true)
      conditions.push(sql`${memories.deletedAt} is null`);
    if (query.q !== undefined && query.q.length > 0) {
      const pattern = `%${query.q.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      const search = or(
        ilike(memoryRevisions.content, pattern),
        ilike(memoryRevisions.rationale, pattern),
        sql`${memoryRevisions.type}::text ilike ${pattern}`,
      );
      if (search !== undefined) conditions.push(search);
    }
    const rows = await this.database
      .select({ memory: memories })
      .from(memories)
      .innerJoin(
        memoryRevisions,
        eq(memoryRevisions.id, memories.currentRevisionId),
      )
      .where(and(...conditions))
      .orderBy(asc(memories.id))
      .limit(query.limit + 1);
    const visible = rows.slice(0, query.limit);
    const items = await Promise.all(
      visible.map(({ memory }) => mapMemory(this.database, memory)),
    );
    const last = visible.at(-1);
    return {
      items,
      ...(rows.length <= query.limit || last === undefined
        ? {}
        : { nextCursor: last.memory.id }),
    };
  }

  public async get(ownerId: string, memoryId: string): Promise<MemoryResource> {
    return mapMemory(
      this.database,
      await ownedMemory(this.database, ownerId, memoryId),
    );
  }

  public async createFeedback(
    ownerId: string,
    input: CreateFeedbackRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    await assertOwnedTarget(this.database, ownerId, input.target);
    const operation = 'feedback.create';
    const requestHash = hash(input);
    const existing = await readLedger(
      this.database,
      ownerId,
      operation,
      idempotencyKey,
      requestHash,
    );
    if (existing !== undefined) {
      if (existing.feedbackId === null)
        throw new MemoryConflictError('Feedback history is incomplete.');
      const [saved] = await this.database
        .select()
        .from(feedback)
        .where(eq(feedback.id, existing.feedbackId))
        .limit(1);
      if (saved === undefined)
        throw new MemoryConflictError('Feedback history is incomplete.');
      const memory =
        saved.resultingMemoryId === null
          ? undefined
          : await this.get(ownerId, saved.resultingMemoryId);
      return {
        feedback: this.mapFeedback(saved),
        ...(memory === undefined ? {} : { memory }),
        replayed: true,
      };
    }

    const result = await inTransaction(this.database, async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${ownerId}:${operation}:${idempotencyKey}`}, 0))`,
      );
      const concurrent = await readLedger(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (concurrent !== undefined) {
        if (concurrent.feedbackId === null)
          throw new MemoryConflictError('Feedback history is incomplete.');
        const [saved] = await transaction
          .select()
          .from(feedback)
          .where(eq(feedback.id, concurrent.feedbackId))
          .limit(1);
        if (saved === undefined)
          throw new MemoryConflictError('Feedback history is incomplete.');
        const [memory] =
          saved.resultingMemoryId === null
            ? []
            : await transaction
                .select()
                .from(memories)
                .where(eq(memories.id, saved.resultingMemoryId))
                .limit(1);
        return { saved, memory, replayed: true };
      }
      await assertOwnedTarget(transaction, ownerId, input.target);
      const feedbackId = createUuidV7<'feedback'>();
      const now = this.now();
      let memory: MemoryRow | undefined;
      let classifiedScope: FeedbackScope = { kind: 'occurrence_only' };
      if (input.mode !== 'occurrence_only') {
        classifiedScope = classifyFeedbackScope({
          memoryType: input.memory.type,
          requestedScope: input.memory.scope,
        });
        if (classifiedScope.kind === 'occurrence_only') {
          throw new DomainInvariantError(
            'Persistent feedback requires an explicit scope.',
          );
        }
        const memoryId = createUuidV7<'memory'>();
        const revisionId = createUuidV7<'memory-revision'>();
        const approved = input.mode === 'correct_and_remember';
        [memory] = await transaction
          .insert(memories)
          .values({
            id: memoryId,
            ownerId,
            currentRevisionId: revisionId,
            currentRevision: 1,
            approvalState: approved ? 'approved' : 'pending',
            enabled: approved,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        await transaction.insert(memoryRevisions).values({
          id: revisionId,
          memoryId,
          revision: 1,
          type: input.memory.type,
          content: input.memory.content,
          rationale: input.memory.rationale,
          creator: approved ? 'user' : 'ai',
          approvalState: approved ? 'approved' : 'pending',
          scope: input.memory.scope,
          enabled: approved,
          createdAt: now,
        });
      }
      const [saved] = await transaction
        .insert(feedback)
        .values({
          id: feedbackId,
          ownerId,
          targetKind: input.target.kind,
          targetId: input.target.id,
          message: input.message,
          classifiedScope,
          ...(memory === undefined ? {} : { resultingMemoryId: memory.id }),
          actorId: ownerId,
          createdAt: now,
        })
        .returning();
      if (saved === undefined)
        throw new MemoryConflictError('Feedback was not created.');
      await transaction.insert(memoryApiIdempotency).values({
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        feedbackId,
        ...(memory === undefined ? {} : { memoryId: memory.id }),
        createdAt: now,
      });
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action:
          memory === undefined
            ? 'feedback.occurrence.recorded'
            : 'memory.created',
        actorId: ownerId,
        entityType: memory === undefined ? 'feedback' : 'memory',
        entityId: memory?.id ?? feedbackId,
        ...(memory === undefined
          ? {}
          : { revisionId: memory.currentRevisionId }),
        correlationId,
        afterHash: hash({
          classifiedScope,
          target: input.target,
          memoryId: memory?.id,
        }),
        metadata: {
          scope: classifiedScope.kind,
          approval:
            input.mode === 'correct_and_remember'
              ? 'approved'
              : input.mode === 'suggest_memory'
                ? 'pending'
                : 'none',
        },
        occurredAt: now,
      });
      return { saved, memory, replayed: false };
    });
    return {
      feedback: this.mapFeedback(result.saved),
      ...(result.memory === undefined
        ? {}
        : { memory: await this.get(ownerId, result.memory.id) }),
      replayed: result.replayed,
    };
  }

  public async mutate(
    ownerId: string,
    memoryId: string,
    expectedRevision: number,
    input: MemoryMutationRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const operation = `memory.${input.operation}.${memoryId}`;
    const requestHash = hash({ expectedRevision, input });
    const ledger = await readLedger(
      this.database,
      ownerId,
      operation,
      idempotencyKey,
      requestHash,
    );
    if (ledger !== undefined) {
      return { memory: await this.get(ownerId, memoryId), replayed: true };
    }
    const replayed = await inTransaction(this.database, async (transaction) => {
      const stable = await ownedMemory(transaction, ownerId, memoryId, true);
      const concurrent = await readLedger(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (concurrent !== undefined) return true;
      if (stable.currentRevision !== expectedRevision)
        throw new MemoryConflictError();
      const [current] = await transaction
        .select()
        .from(memoryRevisions)
        .where(eq(memoryRevisions.id, stable.currentRevisionId))
        .limit(1);
      if (current === undefined)
        throw new MemoryConflictError('Memory history is incomplete.');
      if (stable.deletedAt !== null)
        throw new MemoryConflictError('Deleted memories cannot be changed.');
      const now = this.now();
      let next: {
        type: MemoryRevisionRow['type'];
        content: string;
        rationale: string;
        scope: Readonly<Record<string, unknown>>;
        approvalState: MemoryRow['approvalState'];
        enabled: boolean;
        deletedAt: Date | null;
      } = {
        type: current.type,
        content: current.content,
        rationale: current.rationale,
        scope: current.scope,
        approvalState: stable.approvalState,
        enabled: stable.enabled,
        deletedAt: stable.deletedAt,
      };
      if (input.operation === 'edit') {
        classifyFeedbackScope({
          memoryType: input.memory.type,
          requestedScope: input.memory.scope,
        });
        next = { ...next, ...input.memory };
      } else if (input.operation === 'approve') {
        next = { ...next, approvalState: 'approved' as const, enabled: true };
      } else if (input.operation === 'enable') {
        if (stable.approvalState !== 'approved')
          throw new MemoryConflictError(
            'Approve this memory before enabling it.',
          );
        next = { ...next, enabled: true };
      } else if (input.operation === 'disable') {
        next = { ...next, enabled: false };
      } else {
        next = { ...next, enabled: false, deletedAt: now };
      }
      const revision = stable.currentRevision + 1;
      const revisionId = createUuidV7<'memory-revision'>();
      await transaction.insert(memoryRevisions).values({
        id: revisionId,
        memoryId,
        revision,
        type: next.type,
        content: next.content,
        rationale: next.rationale,
        creator: 'user',
        approvalState: next.approvalState,
        scope: next.scope,
        enabled: next.enabled,
        deletedAt: next.deletedAt,
        createdAt: now,
      });
      await transaction
        .update(memories)
        .set({
          currentRevisionId: revisionId,
          currentRevision: revision,
          approvalState: next.approvalState,
          enabled: next.enabled,
          deletedAt: next.deletedAt,
          updatedAt: now,
        })
        .where(eq(memories.id, memoryId));
      if (input.operation === 'delete') {
        await invalidateExportsForEntity(transaction, {
          ownerId,
          entityId: memoryId,
          now,
          errorCode: 'memory_soft_deleted',
        });
      }
      await transaction.insert(memoryApiIdempotency).values({
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        memoryId,
        createdAt: now,
      });
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: `memory.${input.operation}`,
        actorId: ownerId,
        entityType: 'memory',
        entityId: memoryId,
        revisionId,
        correlationId,
        beforeHash: hash({
          revisionId: stable.currentRevisionId,
          enabled: stable.enabled,
          approvalState: stable.approvalState,
        }),
        afterHash: hash({
          revisionId,
          enabled: next.enabled,
          approvalState: next.approvalState,
          deleted: next.deletedAt !== null,
        }),
        metadata: {
          revision,
          enabled: next.enabled,
          approval: next.approvalState,
          deleted: next.deletedAt !== null,
        },
        occurredAt: now,
      });
      return false;
    });
    return { memory: await this.get(ownerId, memoryId), replayed };
  }

  private mapFeedback(row: typeof feedback.$inferSelect): FeedbackResource {
    return {
      id: row.id,
      target: { kind: row.targetKind, id: row.targetId },
      message: row.message,
      classifiedScope:
        row.classifiedScope as FeedbackResource['classifiedScope'],
      ...(row.resultingMemoryId === null
        ? {}
        : { memoryId: row.resultingMemoryId }),
      createdAt: row.createdAt.toISOString(),
    };
  }
}
