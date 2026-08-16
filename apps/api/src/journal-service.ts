import { createHash } from 'node:crypto';

import type {
  ContributionResource,
  ContributionRevisionResource,
  CreateContributionRequest,
  EditContributionRequest,
  JournalDaySummary,
  JournalDayView,
  MoveContributionRequest,
} from '@journal/contracts';
import {
  JournalReadRepository,
  JournalRecordNotFoundError,
  JournalWriteRepository,
  inTransaction,
  journalApiIdempotency,
  type JournalDatabase,
  type PersistedContribution,
} from '@journal/database';
import {
  createUuidV7,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  parseUuidV7,
  revisionNumber,
  type ContributionRevision,
  type UserId,
} from '@journal/domain';
import { and, eq } from 'drizzle-orm';

export interface MutationResult {
  readonly contribution: ContributionResource;
  readonly replayed: boolean;
}

export interface JournalService {
  listDays(
    ownerId: string,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly JournalDaySummary[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  }>;
  getDay(
    ownerId: string,
    date: string,
    includeDeleted: boolean,
  ): Promise<JournalDayView | undefined>;
  getContribution(
    ownerId: string,
    contributionId: string,
    includeDeleted?: boolean,
  ): Promise<ContributionResource | undefined>;
  listRevisions(
    ownerId: string,
    contributionId: string,
    input: { readonly limit: number; readonly cursor?: string },
  ): Promise<{
    readonly items: readonly ContributionRevisionResource[];
    readonly hasMore: boolean;
    readonly nextCursor?: string;
  }>;
  create(
    ownerId: string,
    input: CreateContributionRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<MutationResult>;
  edit(
    ownerId: string,
    contributionId: string,
    input: EditContributionRequest,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<MutationResult>;
  move(
    ownerId: string,
    contributionId: string,
    input: MoveContributionRequest,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<MutationResult>;
  delete(
    ownerId: string,
    contributionId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<MutationResult>;
  restore(
    ownerId: string,
    contributionId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<MutationResult>;
}

export class IdempotencyConflictError extends Error {
  override readonly name = 'IdempotencyConflictError';
}

type DayCursor = { readonly journalDate: string; readonly id: string };

function encodeCursor(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor<T>(value: string): T {
  try {
    return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as T;
  } catch {
    throw new InvalidJournalCursorError();
  }
}

export class InvalidJournalCursorError extends Error {
  override readonly name = 'InvalidJournalCursorError';
}

function mapRevision(revision: Readonly<ContributionRevision>) {
  return {
    id: revision.revisionId,
    contributionId: revision.entityId,
    revision: revision.revision,
    text: revision.value.text,
    authority: revision.value.authority,
    authorId: revision.value.authorId,
    ...(revision.value.editReason === undefined
      ? {}
      : { editReason: revision.value.editReason }),
    createdAt: revision.createdAt,
  };
}

function mapContribution(record: PersistedContribution): ContributionResource {
  const value = record.contribution;
  return {
    id: value.id,
    journalDayId: value.journalDayId,
    journalDate: value.temporalContext.journalDate,
    authorId: value.authorId,
    sourceType: value.sourceType,
    capturedAt: value.temporalContext.capturedAt,
    capturedTimezone: value.temporalContext.captureTimezone,
    journalTimezone: value.temporalContext.journalTimezone,
    journalDateAssignment: value.temporalContext.journalDateAssignment,
    ...(value.elicitingNudgeId === undefined
      ? {}
      : { elicitingNudgeId: value.elicitingNudgeId }),
    ...(record.currentRevision === undefined
      ? {}
      : { currentRevision: mapRevision(record.currentRevision) }),
    ...(record.deletedAt === undefined ? {} : { deletedAt: record.deletedAt }),
    ...(record.restoredAt === undefined
      ? {}
      : { restoredAt: record.restoredAt }),
  };
}

function hashRequest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export class PostgresJournalService implements JournalService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly now: () => Date = () => new Date(),
  ) {}

  public async listDays(
    ownerId: string,
    input: { readonly limit: number; readonly cursor?: string },
  ) {
    const cursor =
      input.cursor === undefined
        ? undefined
        : decodeCursor<DayCursor>(input.cursor);
    if (cursor !== undefined) {
      parseJournalDate(cursor.journalDate);
      parseUuidV7<'journal-day'>(cursor.id);
    }
    const page = await new JournalReadRepository(
      this.database,
    ).listDaySummaries(parseUuidV7<'user'>(ownerId), {
      limit: input.limit,
      ...(cursor === undefined
        ? {}
        : {
            before: {
              journalDate: parseJournalDate(cursor.journalDate),
              id: parseUuidV7<'journal-day'>(cursor.id),
            },
          }),
    });
    const last = page.items.at(-1)?.day;
    return {
      items: page.items.map(
        ({ day, contributionCount, latestContributionAt }) => ({
          id: day.id,
          journalDate: day.journalDate,
          contributionCount,
          ...(latestContributionAt === undefined
            ? {}
            : { latestContributionAt }),
        }),
      ),
      hasMore: page.hasMore,
      ...(page.hasMore && last !== undefined
        ? {
            nextCursor: encodeCursor({
              journalDate: last.journalDate,
              id: last.id,
            }),
          }
        : {}),
    };
  }

  public async getDay(ownerId: string, date: string, includeDeleted: boolean) {
    const repository = new JournalReadRepository(this.database);
    const owner = parseUuidV7<'user'>(ownerId);
    const journalDate = parseJournalDate(date);
    const day = await repository.findDay(owner, journalDate);
    if (day === undefined) return undefined;
    const contributions = await repository.listDayContributions(
      owner,
      journalDate,
      { includeDeleted },
    );
    return {
      id: day.id,
      journalDate: day.journalDate,
      createdAt: day.createdAt,
      contributions: contributions.map(mapContribution),
    };
  }

  public async getContribution(
    ownerId: string,
    contributionId: string,
    includeDeleted = false,
  ) {
    const result = await new JournalReadRepository(
      this.database,
    ).getContribution(
      parseUuidV7<'user'>(ownerId),
      parseUuidV7<'contribution'>(contributionId),
      { includeDeleted },
    );
    return result === undefined ? undefined : mapContribution(result);
  }

  public async listRevisions(
    ownerId: string,
    contributionId: string,
    input: { readonly limit: number; readonly cursor?: string },
  ) {
    const afterRevision =
      input.cursor === undefined
        ? 0
        : decodeCursor<{ revision: number }>(input.cursor).revision;
    if (!Number.isSafeInteger(afterRevision) || afterRevision < 0)
      throw new InvalidJournalCursorError();
    const page = await new JournalReadRepository(
      this.database,
    ).listContributionRevisionPage(
      parseUuidV7<'user'>(ownerId),
      parseUuidV7<'contribution'>(contributionId),
      {
        limit: input.limit,
        ...(afterRevision === 0 ? {} : { afterRevision }),
      },
    );
    const items = page.items.map(mapRevision);
    const hasMore = page.hasMore;
    return {
      items,
      hasMore,
      ...(hasMore && items.length > 0
        ? { nextCursor: encodeCursor({ revision: items.at(-1)?.revision }) }
        : {}),
    };
  }

  public create(
    ownerId: string,
    input: CreateContributionRequest,
    key: string,
    correlationId: string,
  ) {
    return this.mutate(
      ownerId,
      'create',
      input.contributionId,
      input,
      key,
      correlationId,
      async (repository, owner, audit) => {
        await repository.createTextContribution({
          contributionId: parseUuidV7<'contribution'>(input.contributionId),
          revisionId: parseUuidV7<'contribution-revision'>(input.revisionId),
          proposedJournalDayId: parseUuidV7<'journal-day'>(
            input.proposedJournalDayId,
          ),
          ownerId: owner,
          sourceType: input.sourceType,
          text: input.text,
          capturedAt: parseUtcInstant(input.capturedAt),
          capturedTimezone: parseIanaTimezone(input.capturedTimezone),
          journalTimezone: parseIanaTimezone(input.journalTimezone),
          journalDate: parseJournalDate(input.journalDate),
          journalDateAssignment: input.journalDateAssignment,
          ...(input.elicitingNudgeId === undefined
            ? {}
            : {
                elicitingNudgeId: parseUuidV7<'nudge'>(input.elicitingNudgeId),
              }),
          audit,
        });
      },
    );
  }

  public edit(
    ownerId: string,
    contributionId: string,
    input: EditContributionRequest,
    expectedRevision: number,
    key: string,
    correlationId: string,
  ) {
    return this.mutate(
      ownerId,
      'edit',
      contributionId,
      { input, expectedRevision },
      key,
      correlationId,
      async (repository, owner, audit) => {
        await repository.appendTextRevision({
          ownerId: owner,
          contributionId: parseUuidV7<'contribution'>(contributionId),
          revisionId: parseUuidV7<'contribution-revision'>(input.revisionId),
          expectedRevision: revisionNumber(expectedRevision),
          text: input.text,
          ...(input.editReason === undefined
            ? {}
            : { editReason: input.editReason }),
          audit,
        });
      },
    );
  }

  public move(
    ownerId: string,
    contributionId: string,
    input: MoveContributionRequest,
    expectedRevision: number,
    key: string,
    correlationId: string,
  ) {
    return this.mutate(
      ownerId,
      'move',
      contributionId,
      { input, expectedRevision },
      key,
      correlationId,
      async (repository, owner, audit) => {
        await repository.moveContribution({
          ownerId: owner,
          contributionId: parseUuidV7<'contribution'>(contributionId),
          proposedJournalDayId: parseUuidV7<'journal-day'>(
            input.proposedJournalDayId,
          ),
          journalDate: parseJournalDate(input.journalDate),
          expectedRevision: revisionNumber(expectedRevision),
          audit,
        });
      },
    );
  }

  public delete(
    ownerId: string,
    contributionId: string,
    expectedRevision: number,
    key: string,
    correlationId: string,
  ) {
    return this.mutate(
      ownerId,
      'delete',
      contributionId,
      { expectedRevision },
      key,
      correlationId,
      async (repository, owner, audit) => {
        await repository.softDeleteContribution({
          ownerId: owner,
          contributionId: parseUuidV7<'contribution'>(contributionId),
          expectedRevision: revisionNumber(expectedRevision),
          audit,
        });
      },
      true,
    );
  }

  public restore(
    ownerId: string,
    contributionId: string,
    expectedRevision: number,
    key: string,
    correlationId: string,
  ) {
    return this.mutate(
      ownerId,
      'restore',
      contributionId,
      { expectedRevision },
      key,
      correlationId,
      async (repository, owner, audit) => {
        await repository.restoreContribution({
          ownerId: owner,
          contributionId: parseUuidV7<'contribution'>(contributionId),
          expectedRevision: revisionNumber(expectedRevision),
          audit,
        });
      },
      true,
    );
  }

  private async mutate(
    ownerId: string,
    operation: string,
    contributionId: string,
    request: unknown,
    key: string,
    correlationId: string,
    work: (
      repository: JournalWriteRepository,
      owner: UserId,
      audit: {
        auditId: string;
        correlationId: string;
        occurredAt: ReturnType<typeof parseUtcInstant>;
      },
    ) => Promise<void>,
    includeDeleted = false,
  ): Promise<MutationResult> {
    const owner = parseUuidV7<'user'>(ownerId);
    const requestHash = hashRequest(request);
    return inTransaction(this.database, async (transaction) => {
      const inserted = await transaction
        .insert(journalApiIdempotency)
        .values({
          ownerId: owner,
          operation,
          idempotencyKey: key,
          requestHash,
          contributionId,
        })
        .onConflictDoNothing()
        .returning({ requestHash: journalApiIdempotency.requestHash });
      const replayed = inserted.length === 0;
      if (replayed) {
        const [existing] = await transaction
          .select()
          .from(journalApiIdempotency)
          .where(
            and(
              eq(journalApiIdempotency.ownerId, owner),
              eq(journalApiIdempotency.operation, operation),
              eq(journalApiIdempotency.idempotencyKey, key),
            ),
          )
          .limit(1);
        if (
          existing?.requestHash !== requestHash ||
          existing.contributionId !== contributionId
        )
          throw new IdempotencyConflictError();
      } else {
        const occurredAt = parseUtcInstant(this.now().toISOString());
        await work(new JournalWriteRepository(transaction), owner, {
          auditId: createUuidV7<'audit-event'>(),
          correlationId: parseUuidV7<'correlation'>(correlationId),
          occurredAt,
        });
      }
      const record = await new JournalReadRepository(
        transaction,
      ).getContribution(owner, parseUuidV7<'contribution'>(contributionId), {
        includeDeleted,
      });
      if (record === undefined) throw new JournalRecordNotFoundError();
      return { contribution: mapContribution(record), replayed };
    });
  }
}
