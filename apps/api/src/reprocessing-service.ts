import { createHash } from 'node:crypto';

import {
  reprocessingBatchSchema,
  reprocessingImpactSchema,
  processorDefinitionDraftSchema,
  reprocessingPreviewRequestSchema,
  reprocessingPreviewResponseSchema,
  reprocessingScopeSchema,
  reprocessingVersionBasisSchema,
  type ReprocessingBatch,
  type ReprocessingPreviewRequest,
  type ReprocessingPreviewResponse,
} from '@journal/contracts';
import {
  auditEvents,
  contributions,
  enqueueProcessorRun,
  inTransaction,
  journalDays,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  reprocessingApiIdempotency,
  reprocessingBatchItems,
  reprocessingBatches,
  type JournalDatabase,
  type RepositoryContext,
} from '@journal/database';
import {
  assertBoundedReprocessingRange,
  createUuidV7,
  MAX_REPROCESSING_RUNS,
  providerOperationsPerProcessorRun,
  reprocessingProgress,
  reprocessingStatus,
} from '@journal/domain';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

export class ReprocessingNotFoundError extends Error {
  public constructor(message = 'Reprocessing batch or target not found.') {
    super(message);
    this.name = 'ReprocessingNotFoundError';
  }
}

export class ReprocessingConflictError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ReprocessingConflictError';
  }
}

export interface ReprocessingService {
  preview(
    ownerId: string,
    request: ReprocessingPreviewRequest,
  ): Promise<ReprocessingPreviewResponse>;
  start(
    ownerId: string,
    request: ReprocessingPreviewRequest,
    impactFingerprint: string,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ batch: ReprocessingBatch; replayed: boolean }>>;
  get(ownerId: string, batchId: string): Promise<ReprocessingBatch>;
  list(
    ownerId: string,
    input: Readonly<{ cursor?: string; limit: number }>,
  ): Promise<
    Readonly<{ items: readonly ReprocessingBatch[]; nextCursor?: string }>
  >;
  cancel(
    ownerId: string,
    batchId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<Readonly<{ batch: ReprocessingBatch; replayed: boolean }>>;
}

type VersionBasis = ReprocessingPreviewResponse['versionBasis'];
type PlanTarget = Readonly<{
  journalDayId: string;
  contributionId?: string;
  processorId: string;
  processorVersionId: string;
  providerOperationCount: number;
}>;
type Plan = Readonly<{
  request: ReprocessingPreviewRequest;
  versionBasis: VersionBasis;
  impact: ReprocessingPreviewResponse['impact'];
  fingerprint: string;
  targets: readonly PlanTarget[];
  warnings: readonly string[];
}>;

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function rangeFor(
  request: ReprocessingPreviewRequest,
): Readonly<{ startDate: string; endDate: string }> | undefined {
  const target = request.target;
  if (target.scope === 'journal_day')
    return { startDate: target.journalDate, endDate: target.journalDate };
  if (
    target.scope === 'date_range' ||
    target.scope === 'processor' ||
    target.scope === 'processor_version'
  )
    return { startDate: target.startDate, endDate: target.endDate };
  return undefined;
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

function decodeCursor(
  cursor: string,
): Readonly<{ createdAt: Date; id: string }> {
  const [instant, id, extra] = Buffer.from(cursor, 'base64url')
    .toString('utf8')
    .split('|');
  const createdAt = new Date(instant ?? '');
  if (
    extra !== undefined ||
    id === undefined ||
    Number.isNaN(createdAt.valueOf())
  )
    throw new ReprocessingConflictError('The reprocessing cursor is invalid.');
  return { createdAt, id };
}

export class PostgresReprocessingService implements ReprocessingService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly boss: PgBoss,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private async plan(
    context: RepositoryContext,
    ownerId: string,
    rawRequest: ReprocessingPreviewRequest,
  ): Promise<Plan> {
    const request = reprocessingPreviewRequestSchema.parse(rawRequest);
    const range = rangeFor(request);
    if (range !== undefined)
      assertBoundedReprocessingRange(range.startDate, range.endDate);

    const versionRows = await context
      .select({
        installation: processorInstallations,
        version: processorVersions,
      })
      .from(processorVersions)
      .innerJoin(
        processorInstallations,
        eq(processorInstallations.id, processorVersions.processorId),
      )
      .where(
        request.versionBasis.mode === 'pinned'
          ? inArray(
              processorVersions.id,
              request.versionBasis.processorVersionIds,
            )
          : and(
              eq(processorInstallations.enabled, true),
              eq(processorInstallations.currentVersionId, processorVersions.id),
              request.versionBasis.processorIds === undefined ||
                request.versionBasis.processorIds.length === 0
                ? undefined
                : inArray(
                    processorInstallations.id,
                    request.versionBasis.processorIds,
                  ),
            ),
      )
      .orderBy(asc(processorInstallations.id), asc(processorVersions.id));

    const selectedRows = versionRows.filter(({ installation, version }) => {
      const target = request.target;
      if (target.scope === 'processor')
        return installation.id === target.processorId;
      if (target.scope === 'processor_version')
        return version.id === target.processorVersionId;
      return true;
    });
    if (selectedRows.length === 0)
      throw new ReprocessingNotFoundError(
        'No processor versions match the explicit version basis and scope.',
      );

    const versionBasis = reprocessingVersionBasisSchema.parse({
      mode: request.versionBasis.mode,
      versions: selectedRows.map(({ installation, version }) => {
        const definition = processorDefinitionDraftSchema.parse(
          version.definition,
        );
        if (
          definition.input.scope !== 'contribution' &&
          definition.input.scope !== 'journal_day'
        )
          throw new ReprocessingConflictError(
            'Only contribution and Journal Day processor scopes can be orchestrated.',
          );
        return {
          processorId: installation.id,
          processorName: installation.displayName,
          processorVersionId: version.id,
          semanticVersion: version.semanticVersion,
          inputScope: definition.input.scope,
          providerOperationsPerRun: providerOperationsPerProcessorRun(
            definition.capabilityRequirements,
          ),
        };
      }),
    });

    let dayRows: readonly { id: string; journalDate: string }[];
    let contributionRows: readonly { id: string; journalDayId: string }[];
    let contributionCount: number;
    if (request.target.scope === 'contribution') {
      const rows = await context
        .select({
          id: contributions.id,
          journalDayId: contributions.journalDayId,
          journalDate: journalDays.journalDate,
        })
        .from(contributions)
        .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
        .where(
          and(
            eq(contributions.id, request.target.contributionId),
            eq(journalDays.userId, ownerId),
            isNull(contributions.deletedAt),
          ),
        )
        .limit(1);
      const row = rows[0];
      if (row === undefined) throw new ReprocessingNotFoundError();
      dayRows = [{ id: row.journalDayId, journalDate: row.journalDate }];
      contributionRows = [{ id: row.id, journalDayId: row.journalDayId }];
      contributionCount = 1;
    } else {
      if (range === undefined)
        throw new ReprocessingConflictError('Date range missing.');
      dayRows = await context
        .select({ id: journalDays.id, journalDate: journalDays.journalDate })
        .from(journalDays)
        .where(
          and(
            eq(journalDays.userId, ownerId),
            gte(journalDays.journalDate, range.startDate),
            lte(journalDays.journalDate, range.endDate),
          ),
        )
        .orderBy(asc(journalDays.journalDate), asc(journalDays.id));
      if (dayRows.length === 0) throw new ReprocessingNotFoundError();
      const dayIds = dayRows.map(({ id }) => id);
      const [contributionCountRow] = await context
        .select({ value: count() })
        .from(contributions)
        .where(
          and(
            inArray(contributions.journalDayId, dayIds),
            isNull(contributions.deletedAt),
          ),
        );
      contributionCount = contributionCountRow?.value ?? 0;
      contributionRows = versionBasis.versions.some(
        ({ inputScope }) => inputScope === 'contribution',
      )
        ? await context
            .select({
              id: contributions.id,
              journalDayId: contributions.journalDayId,
            })
            .from(contributions)
            .where(
              and(
                inArray(contributions.journalDayId, dayIds),
                isNull(contributions.deletedAt),
              ),
            )
            .orderBy(asc(contributions.journalDayId), asc(contributions.id))
            .limit(MAX_REPROCESSING_RUNS + 1)
        : [];
    }

    const targets: PlanTarget[] = [];
    for (const version of versionBasis.versions) {
      if (version.inputScope === 'contribution') {
        for (const contribution of contributionRows)
          targets.push({
            journalDayId: contribution.journalDayId,
            contributionId: contribution.id,
            processorId: version.processorId,
            processorVersionId: version.processorVersionId,
            providerOperationCount: version.providerOperationsPerRun,
          });
      } else if (request.target.scope !== 'contribution') {
        for (const day of dayRows)
          targets.push({
            journalDayId: day.id,
            processorId: version.processorId,
            processorVersionId: version.processorVersionId,
            providerOperationCount: version.providerOperationsPerRun,
          });
      }
      if (targets.length > MAX_REPROCESSING_RUNS)
        throw new ReprocessingConflictError(
          `Reprocessing impact exceeds the ${MAX_REPROCESSING_RUNS}-run safety bound. Narrow the scope.`,
        );
    }
    if (targets.length === 0)
      throw new ReprocessingConflictError(
        'The selected processor versions are incompatible with the target scope.',
      );

    const targetDayIds = [
      ...new Set(targets.map(({ journalDayId }) => journalDayId)),
    ];
    const targetVersionIds = [
      ...new Set(targets.map(({ processorVersionId }) => processorVersionId)),
    ];
    const targetProcessorIds = [
      ...new Set(targets.map(({ processorId }) => processorId)),
    ];
    const targetContributionIds = [
      ...new Set(targets.flatMap(({ contributionId }) => contributionId ?? [])),
    ];
    // Filter in application code because Drizzle's nullable timestamp predicate is
    // deliberately kept explicit and the result set is bounded by the plan.
    const [staleCountRow] = await context
      .select({ value: count() })
      .from(processorResults)
      .where(
        and(
          inArray(processorResults.targetJournalDayId, targetDayIds),
          inArray(processorResults.processorVersionId, targetVersionIds),
          isNotNull(processorResults.staleAt),
          request.target.scope === 'contribution'
            ? inArray(
                processorResults.targetContributionId,
                targetContributionIds,
              )
            : undefined,
        ),
      );
    const staleArtifactCount = staleCountRow?.value ?? 0;
    const [manualCountRow] = await context
      .select({ value: count() })
      .from(processorArtifactManualRevisions)
      .innerJoin(
        processorArtifacts,
        eq(processorArtifacts.id, processorArtifactManualRevisions.artifactId),
      )
      .where(
        and(
          eq(processorArtifactManualRevisions.active, true),
          inArray(processorArtifacts.targetJournalDayId, targetDayIds),
          inArray(processorArtifacts.processorId, targetProcessorIds),
          request.target.scope === 'contribution'
            ? inArray(
                processorArtifacts.targetContributionId,
                targetContributionIds,
              )
            : undefined,
        ),
      );
    const manualOverrideCount = manualCountRow?.value ?? 0;
    const impact = reprocessingImpactSchema.parse({
      journalDayCount: targetDayIds.length,
      contributionCount,
      runCount: targets.length,
      approximateProviderOperationCount: targets.reduce(
        (sum, item) => sum + item.providerOperationCount,
        0,
      ),
      staleArtifactCount,
      manualOverrideCount,
    });
    const fingerprint = hash({ request, versionBasis, impact, targets });
    return {
      request,
      versionBasis,
      impact,
      fingerprint,
      targets,
      warnings:
        manualOverrideCount > 0
          ? [
              `${manualOverrideCount} active manual override${manualOverrideCount === 1 ? '' : 's'} will remain authoritative.`,
            ]
          : [],
    };
  }

  public async preview(
    ownerId: string,
    request: ReprocessingPreviewRequest,
  ): Promise<ReprocessingPreviewResponse> {
    const plan = await this.plan(this.database, ownerId, request);
    return reprocessingPreviewResponseSchema.parse({
      target: plan.request.target,
      versionBasis: plan.versionBasis,
      impact: plan.impact,
      impactFingerprint: plan.fingerprint,
      warnings: plan.warnings,
      expiresAt: new Date(this.now().valueOf() + 15 * 60_000).toISOString(),
    });
  }

  private async batchResource(
    context: RepositoryContext,
    ownerId: string,
    batchId: string,
  ): Promise<ReprocessingBatch> {
    const [batch] = await context
      .select()
      .from(reprocessingBatches)
      .where(
        and(
          eq(reprocessingBatches.id, batchId),
          eq(reprocessingBatches.ownerId, ownerId),
        ),
      )
      .limit(1);
    if (batch === undefined) throw new ReprocessingNotFoundError();
    const statuses = await context
      .select({
        status: processorRuns.status,
        completedAt: processorRuns.completedAt,
      })
      .from(reprocessingBatchItems)
      .innerJoin(
        processorRuns,
        eq(processorRuns.id, reprocessingBatchItems.runId),
      )
      .where(eq(reprocessingBatchItems.batchId, batch.id));
    const counts = {
      queued: statuses.filter(({ status }) => status === 'queued').length,
      running: statuses.filter(({ status }) => status === 'running').length,
      succeeded: statuses.filter(({ status }) => status === 'succeeded').length,
      failed: statuses.filter(({ status }) => status === 'failed').length,
      canceled: statuses.filter(({ status }) => status === 'canceled').length,
    };
    const progress = reprocessingProgress(counts);
    if (batch.state !== 'active' && batch.state !== 'canceled')
      throw new ReprocessingConflictError(
        'The reprocessing batch has an unsupported persisted state.',
      );
    const status = reprocessingStatus(batch.state, counts);
    const completedAt = statuses
      .flatMap(({ completedAt }) => completedAt ?? [])
      .sort((left, right) => right.valueOf() - left.valueOf())[0];
    return reprocessingBatchSchema.parse({
      id: batch.id,
      revision: batch.revision,
      status,
      target: reprocessingScopeSchema.parse(batch.target),
      versionBasis: reprocessingVersionBasisSchema.parse(batch.versionBasis),
      impact: reprocessingImpactSchema.parse(batch.impact),
      progress,
      ...(batch.cancelRequestedAt === null
        ? {}
        : { cancelRequestedAt: batch.cancelRequestedAt.toISOString() }),
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString(),
      ...((status === 'completed' || status === 'completed_with_failures') &&
      completedAt !== undefined
        ? { completedAt: completedAt.toISOString() }
        : {}),
    });
  }

  public get(ownerId: string, batchId: string): Promise<ReprocessingBatch> {
    return this.batchResource(this.database, ownerId, batchId);
  }

  public async start(
    ownerId: string,
    request: ReprocessingPreviewRequest,
    impactFingerprint: string,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const requestHash = hash({ request, impactFingerprint });
    return inTransaction(this.database, async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtext(${`reprocessing.start:${ownerId}:${idempotencyKey}`})
        )
      `);
      const [replay] = await transaction
        .select()
        .from(reprocessingApiIdempotency)
        .where(
          and(
            eq(reprocessingApiIdempotency.ownerId, ownerId),
            eq(reprocessingApiIdempotency.operation, 'reprocessing.start'),
            eq(reprocessingApiIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (replay !== undefined) {
        if (replay.requestHash !== requestHash)
          throw new ReprocessingConflictError(
            'The idempotency key was reused with a different reprocessing request.',
          );
        return {
          batch: await this.batchResource(transaction, ownerId, replay.batchId),
          replayed: true,
        };
      }
      const plan = await this.plan(transaction, ownerId, request);
      if (plan.fingerprint !== impactFingerprint)
        throw new ReprocessingConflictError(
          'The reprocessing impact changed. Review a fresh preview before confirming.',
        );
      const now = this.now();
      const batchId = createUuidV7<'reprocessing-batch'>();
      await transaction.insert(reprocessingBatches).values({
        id: batchId,
        ownerId,
        target: plan.request.target,
        versionBasis: plan.versionBasis,
        impact: plan.impact,
        impactFingerprint: plan.fingerprint,
        correlationId,
        createdAt: now,
        updatedAt: now,
      });
      for (const [ordinal, target] of plan.targets.entries()) {
        const run = await enqueueProcessorRun({
          boss: this.boss,
          transaction,
          processorVersionId: target.processorVersionId,
          target: {
            scope:
              target.contributionId === undefined
                ? 'journal_day'
                : 'contribution',
            journalDayId: target.journalDayId,
            ...(target.contributionId === undefined
              ? {}
              : { contributionId: target.contributionId }),
          },
          forceReprocess: true,
          now,
        });
        await transaction.insert(reprocessingBatchItems).values({
          batchId,
          ordinal,
          runId: run.id,
          processorId: target.processorId,
          processorVersionId: target.processorVersionId,
          journalDayId: target.journalDayId,
          ...(target.contributionId === undefined
            ? {}
            : { contributionId: target.contributionId }),
          providerOperationCount: target.providerOperationCount,
          createdAt: now,
        });
      }
      const batch = await this.batchResource(transaction, ownerId, batchId);
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'reprocessing.started',
        actorId: ownerId,
        entityType: 'reprocessing_batch',
        entityId: batchId,
        correlationId,
        afterHash: hash(batch),
        metadata: {
          scope: plan.request.target.scope,
          runCount: plan.impact.runCount,
          providerOperationCount: plan.impact.approximateProviderOperationCount,
          processorVersionCount: plan.versionBasis.versions.length,
        },
        occurredAt: now,
      });
      await transaction.insert(reprocessingApiIdempotency).values({
        ownerId,
        operation: 'reprocessing.start',
        idempotencyKey,
        requestHash,
        batchId,
        response: { batchId },
        createdAt: now,
      });
      return { batch, replayed: false };
    });
  }

  public async list(
    ownerId: string,
    input: Readonly<{ cursor?: string; limit: number }>,
  ) {
    const cursor =
      input.cursor === undefined ? undefined : decodeCursor(input.cursor);
    const rows = await this.database
      .select()
      .from(reprocessingBatches)
      .where(
        and(
          eq(reprocessingBatches.ownerId, ownerId),
          cursor === undefined
            ? undefined
            : or(
                lt(reprocessingBatches.createdAt, cursor.createdAt),
                and(
                  eq(reprocessingBatches.createdAt, cursor.createdAt),
                  lt(reprocessingBatches.id, cursor.id),
                ),
              ),
        ),
      )
      .orderBy(
        desc(reprocessingBatches.createdAt),
        desc(reprocessingBatches.id),
      )
      .limit(input.limit + 1);
    const visible = rows.slice(0, input.limit);
    const items = await Promise.all(
      visible.map((row) => this.batchResource(this.database, ownerId, row.id)),
    );
    const last = visible.at(-1);
    return {
      items,
      ...(rows.length > input.limit && last !== undefined
        ? { nextCursor: encodeCursor(last.createdAt, last.id) }
        : {}),
    };
  }

  public async cancel(
    ownerId: string,
    batchId: string,
    expectedRevision: number,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const operation = `reprocessing.cancel.${batchId}`;
    const requestHash = hash({ batchId, expectedRevision });
    return inTransaction(this.database, async (transaction) => {
      await transaction.execute(sql`
        select pg_advisory_xact_lock(
          hashtext(${`${operation}:${ownerId}:${idempotencyKey}`})
        )
      `);
      const [replay] = await transaction
        .select()
        .from(reprocessingApiIdempotency)
        .where(
          and(
            eq(reprocessingApiIdempotency.ownerId, ownerId),
            eq(reprocessingApiIdempotency.operation, operation),
            eq(reprocessingApiIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .limit(1);
      if (replay !== undefined) {
        if (replay.requestHash !== requestHash)
          throw new ReprocessingConflictError(
            'The idempotency key was reused with a different cancellation.',
          );
        return {
          batch: await this.batchResource(transaction, ownerId, replay.batchId),
          replayed: true,
        };
      }
      const [current] = await transaction
        .select()
        .from(reprocessingBatches)
        .where(
          and(
            eq(reprocessingBatches.id, batchId),
            eq(reprocessingBatches.ownerId, ownerId),
          ),
        )
        .limit(1)
        .for('update');
      if (current === undefined) throw new ReprocessingNotFoundError();
      if (current.revision !== expectedRevision)
        throw new ReprocessingConflictError(
          'The reprocessing batch changed. Refresh before canceling.',
        );
      const now = this.now();
      if (current.state !== 'canceled') {
        const runRows = await transaction
          .select({ runId: reprocessingBatchItems.runId })
          .from(reprocessingBatchItems)
          .where(eq(reprocessingBatchItems.batchId, batchId));
        if (runRows.length > 0)
          await transaction
            .update(processorRuns)
            .set({ status: 'canceled', completedAt: now, updatedAt: now })
            .where(
              and(
                inArray(
                  processorRuns.id,
                  runRows.map(({ runId }) => runId),
                ),
                inArray(processorRuns.status, ['queued', 'running']),
              ),
            );
        await transaction
          .update(reprocessingBatches)
          .set({
            state: 'canceled',
            revision: current.revision + 1,
            cancelRequestedAt: now,
            updatedAt: now,
          })
          .where(eq(reprocessingBatches.id, batchId));
      }
      const batch = await this.batchResource(transaction, ownerId, batchId);
      await transaction.insert(auditEvents).values({
        id: createUuidV7<'audit-event'>(),
        action: 'reprocessing.canceled',
        actorId: ownerId,
        entityType: 'reprocessing_batch',
        entityId: batchId,
        correlationId,
        beforeHash: hash({
          id: current.id,
          revision: current.revision,
          state: current.state,
        }),
        afterHash: hash(batch),
        metadata: {
          canceledRunCount: batch.progress.canceled,
          completedRunCount: batch.progress.succeeded,
        },
        occurredAt: now,
      });
      await transaction.insert(reprocessingApiIdempotency).values({
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        batchId,
        response: { batchId },
        createdAt: now,
      });
      return { batch, replayed: false };
    });
  }
}
