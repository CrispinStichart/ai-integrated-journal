import { createHash } from 'node:crypto';

import {
  nudgeActionRequestSchema,
  processorDefinitionDraftSchema,
  type NudgeActionRequest,
  type NudgeDayResource,
  type NudgeDigestResource,
  type NudgePreference,
  type RequirementEvaluationResource,
  type UpdateNudgePreferenceRequest,
} from '@journal/contracts';
import {
  createUuidV7,
  evaluateRequirementRun,
  nextNudgeDeliveryInstant,
  nudgeLocalDate,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  parseUuidV7,
  validateNudgePolicy,
} from '@journal/domain';
import { and, asc, desc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';

import type { JournalDatabase, RepositoryContext } from './client.js';
import {
  journalDays,
  nudgeActions,
  nudgeApiIdempotency,
  nudgeDigests,
  nudgeItems,
  nudgePreferences,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  requirementEvaluations,
  users,
} from './schema.js';
import { inTransaction } from './transaction.js';
import { JournalWriteRepository } from './repositories/journal-repository.js';

export class NudgeStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'NudgeStateError';
  }
}

export class NudgeNotFoundError extends Error {
  public constructor() {
    super('Nudge digest or item not found.');
    this.name = 'NudgeNotFoundError';
  }
}

export class NudgeConflictError extends Error {
  public constructor(
    message = 'The nudge changed before this action was saved.',
  ) {
    super(message);
    this.name = 'NudgeConflictError';
  }
}

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function definitionPolicy(value: unknown, displayName: string) {
  const definition = processorDefinitionDraftSchema.parse(value);
  return {
    allowNotApplicable: definition.nudgePolicy.allowNotApplicable,
    enabled: definition.nudgePolicy.enabled,
    prompt:
      definition.nudgePolicy.prompt ??
      `Add the missing ${displayName.toLocaleLowerCase()} information.`,
  };
}

export interface NudgeScheduleResult {
  readonly createdDigestIds: readonly string[];
  readonly publishedDigestIds: readonly string[];
}

export interface NudgeActionResult {
  readonly digestId: string;
  readonly journalDate: string;
  readonly responseContributionId: string;
  readonly replayed: boolean;
}

/** Persistence boundary for exact-version evaluation and owner-local nudges. */
export class NudgeRepository {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly createId: () => string = () => createUuidV7<'nudge'>(),
  ) {}

  public async getPreferences(ownerId: string): Promise<NudgePreference> {
    const [owner] = await this.database
      .select()
      .from(users)
      .where(eq(users.id, ownerId))
      .limit(1);
    if (owner === undefined) throw new NudgeNotFoundError();
    const [preference] = await this.database
      .select()
      .from(nudgePreferences)
      .where(eq(nudgePreferences.ownerId, ownerId))
      .limit(1);
    return {
      quietStartHour: preference?.quietStartHour ?? 21,
      quietEndHour: preference?.quietEndHour ?? 8,
      dailyLimit: preference?.dailyLimit ?? 1,
      revision: preference?.revision ?? 1,
      ownerTimezone: owner.journalTimeZone,
      updatedAt: (preference?.updatedAt ?? owner.updatedAt).toISOString(),
    };
  }

  public async updatePreferences(
    input: Readonly<{
      ownerId: string;
      expectedRevision: number;
      request: UpdateNudgePreferenceRequest;
      idempotencyKey: string;
      now?: Date;
    }>,
  ): Promise<Readonly<{ preference: NudgePreference; replayed: boolean }>> {
    const now = input.now ?? new Date();
    const requestHash = hash(input.request);
    const result = await inTransaction(this.database, async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`nudge-preferences:${input.ownerId}`}))`,
      );
      const [ledger] = await transaction
        .select()
        .from(nudgeApiIdempotency)
        .where(
          and(
            eq(nudgeApiIdempotency.ownerId, input.ownerId),
            eq(nudgeApiIdempotency.operation, 'nudge.preferences.update'),
            eq(nudgeApiIdempotency.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (ledger !== undefined) {
        if (
          ledger.requestHash !== requestHash ||
          ledger.preferenceRevision === null
        )
          throw new NudgeConflictError(
            'The idempotency key was reused with different input.',
          );
        return { replayed: true };
      }
      const [owner] = await transaction
        .select()
        .from(users)
        .where(eq(users.id, input.ownerId))
        .limit(1);
      if (owner === undefined) throw new NudgeNotFoundError();
      const [stored] = await transaction
        .select()
        .from(nudgePreferences)
        .where(eq(nudgePreferences.ownerId, input.ownerId))
        .limit(1);
      const current = {
        revision: stored?.revision ?? 1,
        ownerTimezone: owner.journalTimeZone,
      };
      if (current.revision !== input.expectedRevision)
        throw new NudgeConflictError();
      validateNudgePolicy({
        timezone: current.ownerTimezone,
        ...input.request,
      });
      const revision = current.revision + 1;
      await transaction
        .insert(nudgePreferences)
        .values({
          ownerId: input.ownerId,
          ...input.request,
          revision,
          updatedAt: now,
        })
        .onConflictDoUpdate({
          target: nudgePreferences.ownerId,
          set: { ...input.request, revision, updatedAt: now },
        });
      await transaction.insert(nudgeApiIdempotency).values({
        ownerId: input.ownerId,
        operation: 'nudge.preferences.update',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        preferenceRevision: revision,
        createdAt: now,
      });
      return { replayed: false };
    });
    return { preference: await this.getPreferences(input.ownerId), ...result };
  }

  public async recordProcessorRun(
    runId: string,
    now = new Date(),
  ): Promise<void> {
    await inTransaction(this.database, async (transaction) => {
      const [record] = await transaction
        .select({
          run: processorRuns,
          processor: processorInstallations,
          version: processorVersions,
          result: processorResults,
        })
        .from(processorRuns)
        .innerJoin(
          processorInstallations,
          eq(processorInstallations.id, processorRuns.processorId),
        )
        .innerJoin(
          processorVersions,
          eq(processorVersions.id, processorRuns.processorVersionId),
        )
        .leftJoin(
          processorResults,
          eq(processorResults.runId, processorRuns.id),
        )
        .where(eq(processorRuns.id, runId))
        .limit(1);
      if (record === undefined)
        throw new NudgeStateError('Processor run does not exist.');
      const journalDayId = record.run.targetJournalDayId;
      if (journalDayId === null)
        throw new NudgeStateError(
          'Requirement runs must target a Journal Day.',
        );
      const policy = definitionPolicy(
        record.version.definition,
        record.processor.displayName,
      );
      if (
        !record.processor.enabled ||
        record.processor.requirementMode !== 'required' ||
        !policy.enabled
      )
        return;
      const state = evaluateRequirementRun({
        runStatus: record.run.status,
        ...(record.result === null
          ? {}
          : {
              completeness: record.result.completeness,
              payload: record.result.payload,
            }),
      });
      const [existing] = await transaction
        .select()
        .from(requirementEvaluations)
        .where(
          and(
            eq(requirementEvaluations.journalDayId, journalDayId),
            eq(requirementEvaluations.processorVersionId, record.version.id),
          ),
        )
        .limit(1);
      if (existing?.manualResolution) return;
      if (existing === undefined) {
        await transaction.insert(requirementEvaluations).values({
          id: this.createId(),
          journalDayId,
          processorId: record.processor.id,
          processorVersionId: record.version.id,
          supportingRunId: record.run.id,
          state,
          revision: 1,
          ...(state === 'not_evaluated' ? {} : { evaluatedAt: now }),
          createdAt: now,
          updatedAt: now,
        });
        return;
      }
      await transaction
        .update(requirementEvaluations)
        .set({
          supportingRunId: record.run.id,
          state,
          revision: existing.revision + 1,
          evaluatedAt: state === 'not_evaluated' ? null : now,
          updatedAt: now,
        })
        .where(eq(requirementEvaluations.id, existing.id));
    });
  }

  public async runSchedule(now = new Date()): Promise<NudgeScheduleResult> {
    const created: string[] = [];
    const published: string[] = [];
    const due = await this.database
      .select({ id: nudgeDigests.id })
      .from(nudgeDigests)
      .where(
        and(
          inArray(nudgeDigests.status, ['queued', 'deferred']),
          lte(nudgeDigests.scheduledAt, now),
        ),
      );
    for (const row of due) {
      const changed = await this.publishDueDigest(row.id, now);
      if (changed) published.push(row.id);
    }

    const eligible = await this.database
      .select({ ownerId: journalDays.userId })
      .from(requirementEvaluations)
      .innerJoin(
        journalDays,
        eq(journalDays.id, requirementEvaluations.journalDayId),
      )
      .where(eq(requirementEvaluations.state, 'insufficient_information'));
    for (const ownerId of new Set(eligible.map((row) => row.ownerId))) {
      const result = await this.createOwnerDigest(ownerId, now);
      if (result === undefined) continue;
      created.push(result.id);
      if (result.published) published.push(result.id);
    }
    return Object.freeze({
      createdDigestIds: Object.freeze(created),
      publishedDigestIds: Object.freeze(published),
    });
  }

  private async publishDueDigest(
    digestId: string,
    now: Date,
  ): Promise<boolean> {
    return inTransaction(this.database, async (transaction) => {
      const [digest] = await transaction
        .select()
        .from(nudgeDigests)
        .where(eq(nudgeDigests.id, digestId))
        .for('update');
      if (
        digest === undefined ||
        !['queued', 'deferred'].includes(digest.status) ||
        digest.scheduledAt > now
      )
        return false;
      await transaction
        .update(nudgeDigests)
        .set({
          status: 'published',
          publishedAt: now,
          deferredUntil: null,
          revision: digest.revision + 1,
          updatedAt: now,
        })
        .where(eq(nudgeDigests.id, digest.id));
      return true;
    });
  }

  private async createOwnerDigest(
    ownerId: string,
    now: Date,
  ): Promise<Readonly<{ id: string; published: boolean }> | undefined> {
    return inTransaction(this.database, async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`nudge-digest:${ownerId}`}))`,
      );
      const [owner] = await transaction
        .select()
        .from(users)
        .where(eq(users.id, ownerId))
        .limit(1);
      if (owner === undefined) return undefined;
      const [storedPreference] = await transaction
        .select()
        .from(nudgePreferences)
        .where(eq(nudgePreferences.ownerId, ownerId))
        .limit(1);
      const policy = validateNudgePolicy({
        timezone: owner.journalTimeZone,
        quietStartHour: storedPreference?.quietStartHour ?? 21,
        quietEndHour: storedPreference?.quietEndHour ?? 8,
        dailyLimit: storedPreference?.dailyLimit ?? 1,
      });
      if (policy.dailyLimit === 0) return undefined;
      const localDate = nudgeLocalDate(
        parseUtcInstant(now.toISOString()),
        policy.timezone,
      );
      const countRows = await transaction
        .select({ count: sql<number>`count(*)::int` })
        .from(nudgeDigests)
        .where(
          and(
            eq(nudgeDigests.ownerId, ownerId),
            eq(nudgeDigests.notificationDate, localDate),
          ),
        );
      if ((countRows[0]?.count ?? 0) >= policy.dailyLimit) return undefined;
      const candidates = await transaction
        .select({
          evaluation: requirementEvaluations,
          day: journalDays,
        })
        .from(requirementEvaluations)
        .innerJoin(
          journalDays,
          eq(journalDays.id, requirementEvaluations.journalDayId),
        )
        .leftJoin(
          nudgeItems,
          eq(nudgeItems.evaluationId, requirementEvaluations.id),
        )
        .where(
          and(
            eq(journalDays.userId, ownerId),
            eq(requirementEvaluations.state, 'insufficient_information'),
            isNull(nudgeItems.id),
          ),
        )
        .orderBy(desc(journalDays.journalDate), asc(requirementEvaluations.id));
      const dayId = candidates[0]?.day.id;
      if (dayId === undefined) return undefined;
      const grouped = candidates
        .filter(({ day }) => day.id === dayId)
        .slice(0, 32);
      const scheduledAt = new Date(
        nextNudgeDeliveryInstant(
          parseUtcInstant(now.toISOString()),
          policy.timezone,
          {
            startHour: policy.quietStartHour,
            endHour: policy.quietEndHour,
          },
        ),
      );
      const publishedNow = scheduledAt.getTime() <= now.getTime();
      const digestId = this.createId();
      await transaction.insert(nudgeDigests).values({
        id: digestId,
        ownerId,
        journalDayId: dayId,
        notificationDate: localDate,
        status: publishedNow ? 'published' : 'queued',
        scheduledAt,
        ...(publishedNow ? { publishedAt: now } : {}),
        createdAt: now,
        updatedAt: now,
      });
      await transaction.insert(nudgeItems).values(
        grouped.map(({ evaluation }) => ({
          id: this.createId(),
          digestId,
          evaluationId: evaluation.id,
          createdAt: now,
        })),
      );
      await transaction
        .update(requirementEvaluations)
        .set({
          state: 'pending_user_response',
          revision: sql`${requirementEvaluations.revision} + 1`,
          updatedAt: now,
        })
        .where(
          inArray(
            requirementEvaluations.id,
            grouped.map(({ evaluation }) => evaluation.id),
          ),
        );
      return Object.freeze({ id: digestId, published: publishedNow });
    });
  }

  public async getDay(
    ownerId: string,
    journalDate: string,
  ): Promise<NudgeDayResource> {
    const [day] = await this.database
      .select()
      .from(journalDays)
      .where(
        and(
          eq(journalDays.userId, ownerId),
          eq(journalDays.journalDate, journalDate),
        ),
      )
      .limit(1);
    if (day === undefined) return { journalDate, evaluations: [] };
    const evaluations = await this.database
      .select({
        evaluation: requirementEvaluations,
        processor: processorInstallations,
        version: processorVersions,
      })
      .from(requirementEvaluations)
      .innerJoin(
        processorInstallations,
        eq(processorInstallations.id, requirementEvaluations.processorId),
      )
      .innerJoin(
        processorVersions,
        eq(processorVersions.id, requirementEvaluations.processorVersionId),
      )
      .where(eq(requirementEvaluations.journalDayId, day.id))
      .orderBy(asc(processorInstallations.displayName));
    const evaluationResources = evaluations.map(
      ({ evaluation, processor, version }) =>
        this.mapEvaluation(day.journalDate, evaluation, processor, version),
    );
    const [digest] = await this.database
      .select()
      .from(nudgeDigests)
      .where(eq(nudgeDigests.journalDayId, day.id))
      .orderBy(desc(nudgeDigests.createdAt))
      .limit(1);
    return {
      journalDate: day.journalDate,
      evaluations: evaluationResources,
      ...(digest === undefined
        ? {}
        : { digest: await this.mapDigest(digest, evaluationResources) }),
    };
  }

  private mapEvaluation(
    journalDate: string,
    evaluation: typeof requirementEvaluations.$inferSelect,
    processor: typeof processorInstallations.$inferSelect,
    version: typeof processorVersions.$inferSelect,
  ): RequirementEvaluationResource {
    const policy = definitionPolicy(version.definition, processor.displayName);
    return {
      id: evaluation.id,
      journalDayId: evaluation.journalDayId,
      journalDate,
      processorId: evaluation.processorId,
      processorVersionId: evaluation.processorVersionId,
      processorName: processor.displayName,
      state: evaluation.state,
      revision: evaluation.revision,
      allowNotApplicable: policy.allowNotApplicable,
      prompt: policy.prompt,
      ...(evaluation.supportingRunId === null
        ? {}
        : { supportingRunId: evaluation.supportingRunId }),
      ...(evaluation.responseContributionId === null
        ? {}
        : { responseContributionId: evaluation.responseContributionId }),
      ...(evaluation.evaluatedAt === null
        ? {}
        : { evaluatedAt: evaluation.evaluatedAt.toISOString() }),
      updatedAt: evaluation.updatedAt.toISOString(),
    };
  }

  private async mapDigest(
    digest: typeof nudgeDigests.$inferSelect,
    evaluations: readonly RequirementEvaluationResource[],
  ): Promise<NudgeDigestResource> {
    const items = await this.database
      .select()
      .from(nudgeItems)
      .where(eq(nudgeItems.digestId, digest.id))
      .orderBy(asc(nudgeItems.createdAt), asc(nudgeItems.id));
    const byId = new Map(
      evaluations.map((evaluation) => [evaluation.id, evaluation]),
    );
    return {
      id: digest.id,
      journalDayId: digest.journalDayId,
      journalDate:
        evaluations[0]?.journalDate ??
        parseJournalDate(digest.notificationDate),
      status: digest.status,
      revision: digest.revision,
      scheduledAt: digest.scheduledAt.toISOString(),
      ...(digest.publishedAt === null
        ? {}
        : { publishedAt: digest.publishedAt.toISOString() }),
      ...(digest.deferredUntil === null
        ? {}
        : { deferredUntil: digest.deferredUntil.toISOString() }),
      items: items.map((item) => {
        const evaluation = byId.get(item.evaluationId);
        if (evaluation === undefined)
          throw new NudgeStateError('Nudge evaluation history is incomplete.');
        return {
          id: item.id,
          evaluationId: evaluation.id,
          processorName: evaluation.processorName,
          prompt: evaluation.prompt,
          allowNotApplicable: evaluation.allowNotApplicable,
          state: evaluation.state,
        };
      }),
      createdAt: digest.createdAt.toISOString(),
      updatedAt: digest.updatedAt.toISOString(),
    };
  }

  public async act(
    input: Readonly<{
      ownerId: string;
      digestId: string;
      expectedRevision: number;
      request: NudgeActionRequest;
      idempotencyKey: string;
      correlationId: string;
      now?: Date;
    }>,
  ): Promise<NudgeActionResult> {
    const request = nudgeActionRequestSchema.parse(input.request);
    const now = input.now ?? new Date();
    const requestHash = hash(request);
    return inTransaction(this.database, async (transaction) => {
      const [ledger] = await transaction
        .select()
        .from(nudgeApiIdempotency)
        .where(
          and(
            eq(nudgeApiIdempotency.ownerId, input.ownerId),
            eq(nudgeApiIdempotency.operation, 'nudge.action'),
            eq(nudgeApiIdempotency.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (ledger !== undefined) {
        if (
          ledger.requestHash !== requestHash ||
          ledger.digestId !== input.digestId ||
          ledger.responseContributionId === null
        )
          throw new NudgeConflictError(
            'The idempotency key was reused with different input.',
          );
        const [day] = await transaction
          .select({ journalDate: journalDays.journalDate })
          .from(nudgeDigests)
          .innerJoin(journalDays, eq(journalDays.id, nudgeDigests.journalDayId))
          .where(eq(nudgeDigests.id, ledger.digestId as string))
          .limit(1);
        if (day === undefined)
          throw new NudgeStateError('Nudge history is incomplete.');
        return {
          digestId: ledger.digestId,
          journalDate: day.journalDate,
          responseContributionId: ledger.responseContributionId,
          replayed: true,
        };
      }
      const [owned] = await transaction
        .select({ digest: nudgeDigests, day: journalDays, owner: users })
        .from(nudgeDigests)
        .innerJoin(journalDays, eq(journalDays.id, nudgeDigests.journalDayId))
        .innerJoin(users, eq(users.id, nudgeDigests.ownerId))
        .where(
          and(
            eq(nudgeDigests.id, input.digestId),
            eq(nudgeDigests.ownerId, input.ownerId),
          ),
        )
        .for('update')
        .limit(1);
      if (owned === undefined) throw new NudgeNotFoundError();
      if (owned.digest.revision !== input.expectedRevision)
        throw new NudgeConflictError();
      if (['dismissed', 'resolved'].includes(owned.digest.status))
        throw new NudgeConflictError('This nudge is already complete.');
      const item =
        request.action === 'answer' || request.action === 'not_applicable'
          ? await this.ownedItem(transaction, input.digestId, request.itemId)
          : undefined;
      if (request.action === 'not_applicable') {
        const [evaluation] = await transaction
          .select({
            version: processorVersions,
            processor: processorInstallations,
          })
          .from(requirementEvaluations)
          .innerJoin(
            processorVersions,
            eq(processorVersions.id, requirementEvaluations.processorVersionId),
          )
          .innerJoin(
            processorInstallations,
            eq(processorInstallations.id, requirementEvaluations.processorId),
          )
          .where(eq(requirementEvaluations.id, item?.evaluationId as string))
          .limit(1);
        if (
          evaluation === undefined ||
          !definitionPolicy(
            evaluation.version.definition,
            evaluation.processor.displayName,
          ).allowNotApplicable
        )
          throw new NudgeConflictError(
            'Not applicable is not allowed for this requirement.',
          );
      }
      if (request.action === 'defer' && new Date(request.deferredUntil) <= now)
        throw new NudgeConflictError(
          'A deferred nudge must be scheduled in the future.',
        );
      const responseText = await this.actionText(
        transaction,
        request,
        item?.evaluationId,
      );
      await new JournalWriteRepository(transaction).createTextContribution({
        contributionId: parseUuidV7<'contribution'>(request.contributionId),
        revisionId: parseUuidV7<'contribution-revision'>(request.revisionId),
        proposedJournalDayId: parseUuidV7<'journal-day'>(owned.day.id),
        ownerId: parseUuidV7<'user'>(input.ownerId),
        sourceType: 'nudge_response',
        text: responseText,
        capturedAt: parseUtcInstant(request.capturedAt),
        capturedTimezone: parseIanaTimezone(request.capturedTimezone),
        journalTimezone: parseIanaTimezone(owned.owner.journalTimeZone),
        journalDate: parseJournalDate(owned.day.journalDate),
        journalDateAssignment: 'user_override',
        elicitingNudgeId: parseUuidV7<'nudge'>(owned.digest.id),
        audit: {
          auditId: parseUuidV7<'audit-event'>(this.createId()),
          correlationId: parseUuidV7<'correlation'>(input.correlationId),
          occurredAt: parseUtcInstant(now.toISOString()),
        },
      });
      const actionId = this.createId();
      await transaction.insert(nudgeActions).values({
        id: actionId,
        digestId: owned.digest.id,
        ...(item === undefined ? {} : { itemId: item.id }),
        actorId: input.ownerId,
        action: request.action,
        responseContributionId: request.contributionId,
        ...(request.action === 'defer'
          ? { deferredUntil: new Date(request.deferredUntil) }
          : {}),
        createdAt: now,
      });
      if (request.action === 'answer' || request.action === 'not_applicable') {
        await transaction
          .update(requirementEvaluations)
          .set({
            state: request.action === 'answer' ? 'satisfied' : 'not_applicable',
            manualResolution: true,
            responseContributionId: request.contributionId,
            evaluatedAt: now,
            revision: sql`${requirementEvaluations.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(requirementEvaluations.id, item?.evaluationId as string));
      } else if (request.action === 'dismiss') {
        const digestItems = await transaction
          .select({ evaluationId: nudgeItems.evaluationId })
          .from(nudgeItems)
          .where(eq(nudgeItems.digestId, owned.digest.id));
        await transaction
          .update(requirementEvaluations)
          .set({
            state: 'dismissed',
            manualResolution: true,
            responseContributionId: request.contributionId,
            evaluatedAt: now,
            revision: sql`${requirementEvaluations.revision} + 1`,
            updatedAt: now,
          })
          .where(
            inArray(
              requirementEvaluations.id,
              digestItems.map(({ evaluationId }) => evaluationId),
            ),
          );
      }
      let status: typeof nudgeDigests.$inferSelect.status = owned.digest.status;
      let deferredUntil: Date | null = null;
      let scheduledAt = owned.digest.scheduledAt;
      if (request.action === 'defer') {
        status = 'deferred';
        deferredUntil = new Date(request.deferredUntil);
        const [storedPreference] = await transaction
          .select()
          .from(nudgePreferences)
          .where(eq(nudgePreferences.ownerId, input.ownerId))
          .limit(1);
        scheduledAt = new Date(
          nextNudgeDeliveryInstant(
            parseUtcInstant(request.deferredUntil),
            parseIanaTimezone(owned.owner.journalTimeZone),
            {
              startHour: storedPreference?.quietStartHour ?? 21,
              endHour: storedPreference?.quietEndHour ?? 8,
            },
          ),
        );
      } else if (request.action === 'dismiss') {
        status = 'dismissed';
      } else {
        if (status === 'deferred') status = 'published';
        const remainingRows = await transaction
          .select({
            remaining: sql<number>`count(*) filter (where ${requirementEvaluations.state} = 'pending_user_response')::int`,
          })
          .from(nudgeItems)
          .innerJoin(
            requirementEvaluations,
            eq(requirementEvaluations.id, nudgeItems.evaluationId),
          )
          .where(eq(nudgeItems.digestId, owned.digest.id));
        if ((remainingRows[0]?.remaining ?? 0) === 0) status = 'resolved';
      }
      await transaction
        .update(nudgeDigests)
        .set({
          status,
          scheduledAt,
          deferredUntil,
          revision: owned.digest.revision + 1,
          updatedAt: now,
        })
        .where(eq(nudgeDigests.id, owned.digest.id));
      await transaction.insert(nudgeApiIdempotency).values({
        ownerId: input.ownerId,
        operation: 'nudge.action',
        idempotencyKey: input.idempotencyKey,
        requestHash,
        digestId: owned.digest.id,
        actionId,
        responseContributionId: request.contributionId,
        createdAt: now,
      });
      return {
        digestId: owned.digest.id,
        journalDate: owned.day.journalDate,
        responseContributionId: request.contributionId,
        replayed: false,
      };
    });
  }

  private async ownedItem(
    context: RepositoryContext,
    digestId: string,
    itemId: string,
  ) {
    const [item] = await context
      .select()
      .from(nudgeItems)
      .where(and(eq(nudgeItems.id, itemId), eq(nudgeItems.digestId, digestId)))
      .limit(1);
    if (item === undefined) throw new NudgeNotFoundError();
    return item;
  }

  private async actionText(
    context: RepositoryContext,
    request: NudgeActionRequest,
    evaluationId: string | undefined,
  ): Promise<string> {
    if (request.action === 'answer') return request.text;
    if (request.action === 'defer')
      return `Deferred required-information prompt until ${request.deferredUntil}.`;
    if (request.action === 'dismiss')
      return 'Dismissed required-information prompts for this Journal Day.';
    const [processor] = await context
      .select({ name: processorInstallations.displayName })
      .from(requirementEvaluations)
      .innerJoin(
        processorInstallations,
        eq(processorInstallations.id, requirementEvaluations.processorId),
      )
      .where(eq(requirementEvaluations.id, evaluationId as string))
      .limit(1);
    if (processor === undefined) throw new NudgeNotFoundError();
    return `Marked ${processor.name} not applicable for this Journal Day.`;
  }
}
