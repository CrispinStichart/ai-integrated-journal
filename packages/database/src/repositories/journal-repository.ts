import { createHash } from 'node:crypto';

import {
  OptimisticConcurrencyError,
  createContribution,
  createContributionRevision,
  createJournalDay,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  parseUuidV7,
  revisionNumber,
  type Contribution,
  type ContributionId,
  type ContributionRevision,
  type ContributionRevisionId,
  type ContributionSourceType,
  type IanaTimezone,
  type JournalDate,
  type JournalDay,
  type JournalDayId,
  type NudgeId,
  type RevisionNumber,
  type UserId,
  type UtcInstant,
} from '@journal/domain';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  isNull,
  lt,
  or,
  sql,
} from 'drizzle-orm';

import type { JournalTransaction, RepositoryContext } from '../client.js';
import {
  auditEvents,
  contributionRevisions,
  contributions,
  journalDays,
  recordings,
} from '../schema.js';

export type JournalMutationAudit = Readonly<{
  auditId: string;
  correlationId: string;
  occurredAt: UtcInstant;
}>;

export class JournalRecordNotFoundError extends Error {
  override readonly name = 'JournalRecordNotFoundError';
}

export class DeletedContributionError extends Error {
  override readonly name = 'DeletedContributionError';
}

export interface PersistedContribution {
  readonly contribution: Readonly<Contribution>;
  readonly deletedAt?: UtcInstant;
  readonly deletedBy?: UserId;
  readonly restoredAt?: UtcInstant;
  readonly restoredBy?: UserId;
  readonly currentRevision?: Readonly<ContributionRevision>;
  readonly recording?: typeof recordings.$inferSelect;
}

export interface ContributionAuditRecord {
  readonly id: string;
  readonly action: string;
  readonly actorId: UserId | null;
  readonly occurredAt: UtcInstant;
  readonly correlationId: string;
  readonly revisionId: ContributionRevisionId | null;
  readonly beforeHash: string | null;
  readonly afterHash: string | null;
  readonly metadata: Readonly<Record<string, string | number | boolean | null>>;
}

export interface JournalDaySummaryRecord {
  readonly day: Readonly<JournalDay>;
  readonly contributionCount: number;
  readonly latestContributionAt?: UtcInstant;
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function toDate(instant: UtcInstant): Date {
  return new Date(instant);
}

function fromDate(value: Date | string): UtcInstant {
  return parseUtcInstant(
    value instanceof Date ? value.toISOString() : new Date(value).toISOString(),
  );
}

/** Read paths exclude recoverably deleted contributions unless explicitly asked. */
export class JournalReadRepository {
  public constructor(private readonly context: RepositoryContext) {}

  public async findDay(
    ownerId: UserId,
    journalDate: JournalDate,
  ): Promise<Readonly<JournalDay> | undefined> {
    const [row] = await this.context
      .select()
      .from(journalDays)
      .where(
        and(
          eq(journalDays.userId, ownerId),
          eq(journalDays.journalDate, journalDate),
        ),
      )
      .limit(1);

    return row === undefined
      ? undefined
      : createJournalDay({
          id: parseUuidV7<'journal-day'>(row.id),
          ownerId: parseUuidV7<'user'>(row.userId),
          journalDate: parseJournalDate(row.journalDate),
          createdAt: fromDate(row.createdAt),
        });
  }

  public async getContribution(
    ownerId: UserId,
    contributionId: ContributionId,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<PersistedContribution | undefined> {
    const deletedPredicate = options.includeDeleted
      ? undefined
      : isNull(contributions.deletedAt);
    const [row] = await this.context
      .select({
        contribution: contributions,
        day: journalDays,
        revision: contributionRevisions,
        recording: recordings,
      })
      .from(contributions)
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .leftJoin(
        contributionRevisions,
        eq(contributionRevisions.id, contributions.currentRevisionId),
      )
      .leftJoin(recordings, eq(recordings.contributionId, contributions.id))
      .where(
        and(
          eq(contributions.id, contributionId),
          eq(journalDays.userId, ownerId),
          deletedPredicate,
        ),
      )
      .limit(1);

    return row === undefined ? undefined : mapContributionRow(row);
  }

  public async listDaySummaries(
    ownerId: UserId,
    input: {
      readonly limit: number;
      readonly before?: {
        readonly journalDate: JournalDate;
        readonly id: JournalDayId;
      };
    },
  ): Promise<{
    readonly items: readonly JournalDaySummaryRecord[];
    readonly hasMore: boolean;
  }> {
    const before = input.before;
    const rows = await this.context
      .select({
        day: journalDays,
        contributionCount: count(contributions.id),
        latestContributionAt: sql<
          Date | string | null
        >`max(${contributions.createdAt})`,
      })
      .from(journalDays)
      .leftJoin(
        contributions,
        and(
          eq(contributions.journalDayId, journalDays.id),
          isNull(contributions.deletedAt),
        ),
      )
      .where(
        and(
          eq(journalDays.userId, ownerId),
          before === undefined
            ? undefined
            : or(
                lt(journalDays.journalDate, before.journalDate),
                and(
                  eq(journalDays.journalDate, before.journalDate),
                  lt(journalDays.id, before.id),
                ),
              ),
        ),
      )
      .groupBy(journalDays.id)
      .orderBy(desc(journalDays.journalDate), desc(journalDays.id))
      .limit(input.limit + 1);
    return {
      items: rows.slice(0, input.limit).map((row) => ({
        day: createJournalDay({
          id: parseUuidV7<'journal-day'>(row.day.id),
          ownerId: parseUuidV7<'user'>(row.day.userId),
          journalDate: parseJournalDate(row.day.journalDate),
          createdAt: fromDate(row.day.createdAt),
        }),
        contributionCount: Number(row.contributionCount),
        ...(row.latestContributionAt === null
          ? {}
          : { latestContributionAt: fromDate(row.latestContributionAt) }),
      })),
      hasMore: rows.length > input.limit,
    };
  }

  public async listDayContributions(
    ownerId: UserId,
    journalDate: JournalDate,
    options: { readonly includeDeleted?: boolean } = {},
  ): Promise<readonly PersistedContribution[]> {
    const rows = await this.context
      .select({
        contribution: contributions,
        day: journalDays,
        revision: contributionRevisions,
        recording: recordings,
      })
      .from(journalDays)
      .innerJoin(contributions, eq(contributions.journalDayId, journalDays.id))
      .leftJoin(
        contributionRevisions,
        eq(contributionRevisions.id, contributions.currentRevisionId),
      )
      .leftJoin(recordings, eq(recordings.contributionId, contributions.id))
      .where(
        and(
          eq(journalDays.userId, ownerId),
          eq(journalDays.journalDate, journalDate),
          options.includeDeleted ? undefined : isNull(contributions.deletedAt),
        ),
      )
      .orderBy(asc(contributions.createdAt), asc(contributions.id));
    return rows.map(mapContributionRow);
  }

  public async listContributionRevisions(
    ownerId: UserId,
    contributionId: ContributionId,
  ): Promise<Readonly<ContributionRevision>[]> {
    const rows = await this.context
      .select({ revision: contributionRevisions })
      .from(contributionRevisions)
      .innerJoin(
        contributions,
        eq(contributions.id, contributionRevisions.contributionId),
      )
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(
        and(
          eq(contributionRevisions.contributionId, contributionId),
          eq(journalDays.userId, ownerId),
        ),
      )
      .orderBy(asc(contributionRevisions.revision));

    return rows.map(({ revision }) => mapRevision(revision));
  }

  public async listContributionRevisionPage(
    ownerId: UserId,
    contributionId: ContributionId,
    input: { readonly limit: number; readonly afterRevision?: number },
  ): Promise<{
    readonly items: readonly Readonly<ContributionRevision>[];
    readonly hasMore: boolean;
  }> {
    const rows = await this.context
      .select({ revision: contributionRevisions })
      .from(contributionRevisions)
      .innerJoin(
        contributions,
        eq(contributions.id, contributionRevisions.contributionId),
      )
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(
        and(
          eq(contributionRevisions.contributionId, contributionId),
          eq(journalDays.userId, ownerId),
          input.afterRevision === undefined
            ? undefined
            : gt(contributionRevisions.revision, input.afterRevision),
        ),
      )
      .orderBy(asc(contributionRevisions.revision))
      .limit(input.limit + 1);
    return {
      items: rows
        .slice(0, input.limit)
        .map(({ revision }) => mapRevision(revision)),
      hasMore: rows.length > input.limit,
    };
  }

  public async listContributionAuditHistory(
    ownerId: UserId,
    contributionId: ContributionId,
  ): Promise<ContributionAuditRecord[]> {
    const owned = await this.getContribution(ownerId, contributionId, {
      includeDeleted: true,
    });
    if (owned === undefined) return [];

    const rows = await this.context
      .select()
      .from(auditEvents)
      .where(
        and(
          eq(auditEvents.entityType, 'contribution'),
          eq(auditEvents.entityId, contributionId),
        ),
      )
      .orderBy(desc(auditEvents.occurredAt), desc(auditEvents.id));

    return rows.map((row) => ({
      id: row.id,
      action: row.action,
      actorId: row.actorId === null ? null : parseUuidV7<'user'>(row.actorId),
      occurredAt: fromDate(row.occurredAt),
      correlationId: row.correlationId,
      revisionId:
        row.revisionId === null
          ? null
          : parseUuidV7<'contribution-revision'>(row.revisionId),
      beforeHash: row.beforeHash,
      afterHash: row.afterHash,
      metadata: row.metadata,
    }));
  }
}

/**
 * Transaction-only journal commands. The caller owns the transaction so each
 * state change, immutable revision, and content-free audit event commit as one.
 */
export class JournalWriteRepository {
  public constructor(private readonly transaction: JournalTransaction) {}

  public async createTextContribution(input: {
    readonly contributionId: ContributionId;
    readonly revisionId: ContributionRevisionId;
    readonly proposedJournalDayId: JournalDayId;
    readonly ownerId: UserId;
    readonly sourceType: Exclude<ContributionSourceType, 'recording'>;
    readonly text: string;
    readonly capturedAt: UtcInstant;
    readonly capturedTimezone: IanaTimezone;
    readonly journalTimezone: IanaTimezone;
    readonly journalDate: JournalDate;
    readonly journalDateAssignment: 'default' | 'user_override' | 'migration';
    readonly elicitingNudgeId?: NudgeId;
    readonly audit: JournalMutationAudit;
  }): Promise<PersistedContribution> {
    const revision = createContributionRevision({
      contributionId: input.contributionId,
      revisionId: input.revisionId,
      text: input.text,
      authority: 'manual',
      authorId: input.ownerId,
      createdAt: input.audit.occurredAt,
    });
    const day = await this.ensureDay(
      input.proposedJournalDayId,
      input.ownerId,
      input.journalDate,
      input.audit.occurredAt,
    );

    await this.transaction.insert(contributions).values({
      id: input.contributionId,
      journalDayId: day.id,
      authorId: input.ownerId,
      sourceType: input.sourceType,
      capturedAt: toDate(input.capturedAt),
      capturedTimezone: input.capturedTimezone,
      journalTimezone: input.journalTimezone,
      journalDateAssignment: input.journalDateAssignment,
      elicitingNudgeId: input.elicitingNudgeId,
      createdAt: toDate(input.audit.occurredAt),
      updatedAt: toDate(input.audit.occurredAt),
    });
    const contentHash = hashText(input.text);
    await this.transaction.insert(contributionRevisions).values({
      id: revision.revisionId,
      contributionId: input.contributionId,
      revision: revision.revision,
      text: revision.value.text,
      authority: revision.value.authority,
      authorId: revision.value.authorId,
      contentHash,
      createdAt: toDate(revision.createdAt),
    });
    await this.transaction
      .update(contributions)
      .set({
        currentRevisionId: revision.revisionId,
        currentRevision: revision.revision,
      })
      .where(eq(contributions.id, input.contributionId));
    await this.audit({
      ...input.audit,
      action: 'contribution.created',
      actorId: input.ownerId,
      contributionId: input.contributionId,
      revisionId: revision.revisionId,
      afterHash: contentHash,
      metadata: {
        journalDayId: day.id,
        journalDate: day.journalDate,
        sourceType: input.sourceType,
      },
    });

    return {
      contribution: createContribution({
        id: input.contributionId,
        journalDayId: day.id,
        authorId: input.ownerId,
        sourceType: input.sourceType,
        capturedAt: input.capturedAt,
        capturedTimezone: input.capturedTimezone,
        journalTimezone: input.journalTimezone,
        journalDate: input.journalDate,
        journalDateAssignment: input.journalDateAssignment,
        ...(input.elicitingNudgeId === undefined
          ? {}
          : { elicitingNudgeId: input.elicitingNudgeId }),
        currentRevision: revision.revision,
      }),
      currentRevision: revision,
    };
  }

  public async appendTextRevision(input: {
    readonly ownerId: UserId;
    readonly contributionId: ContributionId;
    readonly revisionId: ContributionRevisionId;
    readonly expectedRevision: RevisionNumber;
    readonly text: string;
    readonly editReason?: string;
    readonly audit: JournalMutationAudit;
  }): Promise<Readonly<ContributionRevision>> {
    const current = await this.lockContribution(
      input.ownerId,
      input.contributionId,
    );
    if (current.deletedAt !== null) throw new DeletedContributionError();
    if (current.currentRevision !== input.expectedRevision) {
      throw new OptimisticConcurrencyError(
        input.expectedRevision,
        current.currentRevision,
      );
    }
    const revision = createContributionRevision({
      contributionId: input.contributionId,
      revisionId: input.revisionId,
      currentRevision: revisionNumber(current.currentRevision),
      expectedRevision: input.expectedRevision,
      text: input.text,
      authority: 'manual',
      authorId: input.ownerId,
      ...(input.editReason === undefined
        ? {}
        : { editReason: input.editReason }),
      createdAt: input.audit.occurredAt,
    });
    const contentHash = hashText(input.text);
    await this.transaction.insert(contributionRevisions).values({
      id: revision.revisionId,
      contributionId: revision.entityId,
      revision: revision.revision,
      text: revision.value.text,
      authority: revision.value.authority,
      authorId: revision.value.authorId,
      editReason: revision.value.editReason,
      contentHash,
      createdAt: toDate(revision.createdAt),
    });
    await this.transaction
      .update(contributions)
      .set({
        currentRevisionId: revision.revisionId,
        currentRevision: revision.revision,
        updatedAt: toDate(input.audit.occurredAt),
      })
      .where(eq(contributions.id, input.contributionId));
    await this.audit({
      ...input.audit,
      action: 'contribution.revised',
      actorId: input.ownerId,
      contributionId: input.contributionId,
      revisionId: revision.revisionId,
      beforeHash: current.currentContentHash,
      afterHash: contentHash,
      metadata: { revision: revision.revision },
    });
    return revision;
  }

  public async moveContribution(input: {
    readonly ownerId: UserId;
    readonly contributionId: ContributionId;
    readonly proposedJournalDayId: JournalDayId;
    readonly journalDate: JournalDate;
    readonly expectedRevision?: number;
    readonly audit: JournalMutationAudit;
  }): Promise<void> {
    const current = await this.lockOwnedContribution(
      input.ownerId,
      input.contributionId,
    );
    if (current.deletedAt !== null) throw new DeletedContributionError();
    if (
      input.expectedRevision !== undefined &&
      current.currentRevision !== input.expectedRevision
    ) {
      throw new OptimisticConcurrencyError(
        input.expectedRevision,
        current.currentRevision,
      );
    }
    const day = await this.ensureDay(
      input.proposedJournalDayId,
      input.ownerId,
      input.journalDate,
      input.audit.occurredAt,
    );
    if (day.id === current.journalDayId) return;

    await this.transaction
      .update(contributions)
      .set({
        journalDayId: day.id,
        journalDateAssignment: 'user_override',
        updatedAt: toDate(input.audit.occurredAt),
      })
      .where(eq(contributions.id, input.contributionId));
    await this.audit({
      ...input.audit,
      action: 'contribution.moved',
      actorId: input.ownerId,
      contributionId: input.contributionId,
      metadata: {
        fromJournalDayId: current.journalDayId,
        fromJournalDate: current.journalDate,
        toJournalDayId: day.id,
        toJournalDate: day.journalDate,
      },
    });
  }

  public async softDeleteContribution(input: {
    readonly ownerId: UserId;
    readonly contributionId: ContributionId;
    readonly expectedRevision?: RevisionNumber;
    readonly audit: JournalMutationAudit;
  }): Promise<void> {
    const current = await this.lockContribution(
      input.ownerId,
      input.contributionId,
    );
    if (current.deletedAt !== null) throw new DeletedContributionError();
    if (
      input.expectedRevision !== undefined &&
      current.currentRevision !== input.expectedRevision
    ) {
      throw new OptimisticConcurrencyError(
        input.expectedRevision,
        current.currentRevision,
      );
    }
    await this.transaction
      .update(contributions)
      .set({
        deletedAt: toDate(input.audit.occurredAt),
        deletedBy: input.ownerId,
        updatedAt: toDate(input.audit.occurredAt),
      })
      .where(eq(contributions.id, input.contributionId));
    await this.audit({
      ...input.audit,
      action: 'contribution.deleted',
      actorId: input.ownerId,
      contributionId: input.contributionId,
      beforeHash: current.currentContentHash,
      metadata: { recoverable: true },
    });
  }

  public async restoreContribution(input: {
    readonly ownerId: UserId;
    readonly contributionId: ContributionId;
    readonly expectedRevision?: RevisionNumber;
    readonly audit: JournalMutationAudit;
  }): Promise<void> {
    const current = await this.lockContribution(
      input.ownerId,
      input.contributionId,
    );
    if (current.deletedAt === null) {
      throw new Error('The contribution is not deleted.');
    }
    if (
      input.expectedRevision !== undefined &&
      current.currentRevision !== input.expectedRevision
    ) {
      throw new OptimisticConcurrencyError(
        input.expectedRevision,
        current.currentRevision,
      );
    }
    await this.transaction
      .update(contributions)
      .set({
        deletedAt: null,
        deletedBy: null,
        restoredAt: toDate(input.audit.occurredAt),
        restoredBy: input.ownerId,
        updatedAt: toDate(input.audit.occurredAt),
      })
      .where(eq(contributions.id, input.contributionId));
    await this.audit({
      ...input.audit,
      action: 'contribution.restored',
      actorId: input.ownerId,
      contributionId: input.contributionId,
      afterHash: current.currentContentHash,
      metadata: { recoverable: true },
    });
  }

  private async ensureDay(
    proposedId: JournalDayId,
    ownerId: UserId,
    journalDate: JournalDate,
    createdAt: UtcInstant,
  ): Promise<Readonly<JournalDay>> {
    await this.transaction
      .insert(journalDays)
      .values({
        id: proposedId,
        userId: ownerId,
        journalDate,
        createdAt: toDate(createdAt),
      })
      .onConflictDoNothing({
        target: [journalDays.userId, journalDays.journalDate],
      });
    const repository = new JournalReadRepository(this.transaction);
    const day = await repository.findDay(ownerId, journalDate);
    if (day === undefined) throw new JournalRecordNotFoundError();
    return day;
  }

  private async lockContribution(
    ownerId: UserId,
    contributionId: ContributionId,
  ) {
    const row = await this.lockOwnedContribution(ownerId, contributionId);
    if (row.currentRevisionId === null) throw new JournalRecordNotFoundError();
    const [revision] = await this.transaction
      .select({ contentHash: contributionRevisions.contentHash })
      .from(contributionRevisions)
      .where(eq(contributionRevisions.id, row.currentRevisionId))
      .limit(1);
    if (revision === undefined) throw new JournalRecordNotFoundError();
    return {
      ...row,
      currentContentHash: revision.contentHash,
    };
  }

  private async lockOwnedContribution(
    ownerId: UserId,
    contributionId: ContributionId,
  ) {
    const [row] = await this.transaction
      .select({
        currentRevision: contributions.currentRevision,
        currentRevisionId: contributions.currentRevisionId,
        deletedAt: contributions.deletedAt,
        journalDayId: contributions.journalDayId,
      })
      .from(contributions)
      .where(eq(contributions.id, contributionId))
      .for('update')
      .limit(1);
    if (row === undefined) throw new JournalRecordNotFoundError();
    const [ownedDay] = await this.transaction
      .select({ journalDate: journalDays.journalDate })
      .from(journalDays)
      .where(
        and(
          eq(journalDays.id, row.journalDayId),
          eq(journalDays.userId, ownerId),
        ),
      )
      .limit(1);
    if (ownedDay === undefined) throw new JournalRecordNotFoundError();
    return {
      ...row,
      journalDate: ownedDay.journalDate,
    };
  }

  private async audit(
    input: JournalMutationAudit & {
      readonly action: string;
      readonly actorId: UserId;
      readonly contributionId: ContributionId;
      readonly revisionId?: ContributionRevisionId;
      readonly beforeHash?: string;
      readonly afterHash?: string;
      readonly metadata: Readonly<
        Record<string, string | number | boolean | null>
      >;
    },
  ): Promise<void> {
    await this.transaction.insert(auditEvents).values({
      id: input.auditId,
      action: input.action,
      actorId: input.actorId,
      entityType: 'contribution',
      entityId: input.contributionId,
      revisionId: input.revisionId,
      correlationId: input.correlationId,
      beforeHash: input.beforeHash,
      afterHash: input.afterHash,
      metadata: input.metadata,
      occurredAt: toDate(input.occurredAt),
    });
  }
}

function mapRevision(
  row: typeof contributionRevisions.$inferSelect,
): Readonly<ContributionRevision> {
  return createContributionRevision({
    contributionId: parseUuidV7<'contribution'>(row.contributionId),
    revisionId: parseUuidV7<'contribution-revision'>(row.id),
    ...(row.revision === 1
      ? {}
      : {
          currentRevision: revisionNumber(row.revision - 1),
          expectedRevision: revisionNumber(row.revision - 1),
        }),
    text: row.text,
    authority: row.authority,
    authorId: parseUuidV7<'user'>(row.authorId),
    ...(row.editReason === null ? {} : { editReason: row.editReason }),
    createdAt: fromDate(row.createdAt),
  });
}

function mapContributionRow(row: {
  contribution: typeof contributions.$inferSelect;
  day: typeof journalDays.$inferSelect;
  revision: typeof contributionRevisions.$inferSelect | null;
  recording: typeof recordings.$inferSelect | null;
}): PersistedContribution {
  const contribution = createContribution({
    id: parseUuidV7<'contribution'>(row.contribution.id),
    journalDayId: parseUuidV7<'journal-day'>(row.day.id),
    authorId: parseUuidV7<'user'>(row.contribution.authorId),
    sourceType: row.contribution.sourceType,
    capturedAt: fromDate(row.contribution.capturedAt),
    capturedTimezone: parseIanaTimezone(row.contribution.capturedTimezone),
    journalTimezone: parseIanaTimezone(row.contribution.journalTimezone),
    journalDate: parseJournalDate(row.day.journalDate),
    journalDateAssignment: row.contribution.journalDateAssignment,
    ...(row.contribution.elicitingNudgeId === null
      ? {}
      : {
          elicitingNudgeId: parseUuidV7<'nudge'>(
            row.contribution.elicitingNudgeId,
          ),
        }),
    ...(row.contribution.currentRevision === 0
      ? {}
      : { currentRevision: revisionNumber(row.contribution.currentRevision) }),
  });
  return {
    contribution,
    ...(row.contribution.deletedAt === null
      ? {}
      : { deletedAt: fromDate(row.contribution.deletedAt) }),
    ...(row.contribution.deletedBy === null
      ? {}
      : { deletedBy: parseUuidV7<'user'>(row.contribution.deletedBy) }),
    ...(row.contribution.restoredAt === null
      ? {}
      : { restoredAt: fromDate(row.contribution.restoredAt) }),
    ...(row.contribution.restoredBy === null
      ? {}
      : { restoredBy: parseUuidV7<'user'>(row.contribution.restoredBy) }),
    ...(row.revision === null
      ? {}
      : { currentRevision: mapRevision(row.revision) }),
    ...(row.recording === null ? {} : { recording: row.recording }),
  };
}
