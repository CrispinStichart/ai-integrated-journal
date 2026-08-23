import { createHash } from 'node:crypto';

import type { ProcessorDefinitionDraft } from '@journal/contracts';
import {
  planReconciliation,
  processorReconciliationCandidates,
  type CurrentReconciliationArtifact,
  type ReconciliationOutcome,
} from '@journal/domain';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';

import type { JournalTransaction } from './client.js';
import {
  processorArtifactCandidates,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorReconciliationOutcomes,
  processorReconciliations,
  type processorResults,
  type processorRuns,
} from './schema.js';

export type ProcessorReconciliationRecord =
  typeof processorReconciliations.$inferSelect;
export type ProcessorReconciliationOutcomeRecord =
  typeof processorReconciliationOutcomes.$inferSelect;

export interface PersistedProcessorReconciliation {
  readonly reconciliation: ProcessorReconciliationRecord;
  readonly outcomes: readonly ProcessorReconciliationOutcomeRecord[];
}

export class ProcessorReconciliationStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'ProcessorReconciliationStateError';
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function sha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function resultKind(
  definition: ProcessorDefinitionDraft,
): 'source_transform' | 'observation' | 'interpretation' | 'other' {
  return definition.kind === 'observation_extractor'
    ? 'observation'
    : definition.kind;
}

async function readPersisted(
  transaction: JournalTransaction,
  runId: string,
): Promise<PersistedProcessorReconciliation | undefined> {
  const [reconciliation] = await transaction
    .select()
    .from(processorReconciliations)
    .where(eq(processorReconciliations.runId, runId))
    .limit(1);
  if (reconciliation === undefined) return undefined;
  const outcomes = await transaction
    .select()
    .from(processorReconciliationOutcomes)
    .where(eq(processorReconciliationOutcomes.runId, runId))
    .orderBy(asc(processorReconciliationOutcomes.ordinal));
  return Object.freeze({ reconciliation, outcomes: Object.freeze(outcomes) });
}

/**
 * Reconciles one exact processor result under a Journal-Day transaction lock.
 * Jobs may be delivered at least once; the run primary key and per-artifact
 * uniqueness constraints are the durable idempotency boundary.
 */
export async function reconcileProcessorResult(input: {
  readonly transaction: JournalTransaction;
  readonly run: typeof processorRuns.$inferSelect;
  readonly result: typeof processorResults.$inferSelect;
  readonly definition: ProcessorDefinitionDraft;
  readonly now: Date;
  readonly createId: () => string;
}): Promise<PersistedProcessorReconciliation> {
  if (input.run.targetJournalDayId === null)
    throw new ProcessorReconciliationStateError(
      'Processor reconciliation requires a target Journal Day.',
    );
  const inputHash = sha256({
    completeness: input.result.completeness,
    logicalKey: input.definition.reconciliation.logicalKey,
    payload: input.result.payload,
    processorVersionId: input.run.processorVersionId,
    strategy: input.definition.reconciliation.strategy,
  });
  const existing = await readPersisted(input.transaction, input.run.id);
  if (existing !== undefined) {
    if (
      existing.reconciliation.inputHash !== inputHash ||
      existing.reconciliation.sourceResultId !== input.result.id
    )
      throw new ProcessorReconciliationStateError(
        'A processor run cannot be reconciled with different immutable output.',
      );
    return existing;
  }

  // One lock key for the whole day serializes different processors too, which
  // keeps day-level interpretations from observing a partially reconciled day.
  await input.transaction.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${'processor-day:' + input.run.targetJournalDayId}, 0))`,
  );

  // A waiter may have been blocked behind the first delivery of the same run.
  const afterLock = await readPersisted(input.transaction, input.run.id);
  if (afterLock !== undefined) {
    if (
      afterLock.reconciliation.inputHash !== inputHash ||
      afterLock.reconciliation.sourceResultId !== input.result.id
    )
      throw new ProcessorReconciliationStateError(
        'A processor run cannot be reconciled with different immutable output.',
      );
    return afterLock;
  }

  const artifactRows = await input.transaction
    .select({
      artifact: processorArtifacts,
      version: processorArtifactVersions,
    })
    .from(processorArtifacts)
    .innerJoin(
      processorArtifactVersions,
      and(
        eq(processorArtifactVersions.artifactId, processorArtifacts.id),
        eq(processorArtifactVersions.lifecycle, 'active'),
      ),
    )
    .where(
      and(
        eq(processorArtifacts.processorId, input.run.processorId),
        eq(processorArtifacts.targetJournalDayId, input.run.targetJournalDayId),
        input.run.targetContributionId === null
          ? isNull(processorArtifacts.targetContributionId)
          : eq(
              processorArtifacts.targetContributionId,
              input.run.targetContributionId,
            ),
        eq(processorArtifacts.active, true),
      ),
    )
    .orderBy(asc(processorArtifacts.logicalKey));
  const current: CurrentReconciliationArtifact[] = artifactRows.map(
    ({ artifact, version }) => ({
      artifactId: artifact.id,
      versionId: version.id,
      logicalKey: artifact.logicalKey,
      payload: version.payload,
      payloadHash: version.payloadHash,
      processorVersionId: version.processorVersionId,
      authority: artifact.authority,
    }),
  );
  const candidates = processorReconciliationCandidates({
    strategy: input.definition.reconciliation.strategy,
    ...(input.definition.reconciliation.logicalKey === undefined
      ? {}
      : { logicalKey: input.definition.reconciliation.logicalKey }),
    payload: input.result.payload,
    hashPayload: sha256,
  });
  const plan = planReconciliation({
    strategy: input.definition.reconciliation.strategy,
    completeness: input.result.completeness,
    processorVersionId: input.run.processorVersionId,
    candidates,
    current,
  });

  const [reconciliation] = await input.transaction
    .insert(processorReconciliations)
    .values({
      runId: input.run.id,
      sourceResultId: input.result.id,
      strategy: input.definition.reconciliation.strategy,
      completeness: input.result.completeness,
      inputHash,
      completedAt: input.now,
    })
    .returning();
  if (reconciliation === undefined)
    throw new ProcessorReconciliationStateError(
      'Processor reconciliation was not stored.',
    );

  const persisted: ProcessorReconciliationOutcomeRecord[] = [];
  for (const [ordinal, planned] of plan.entries()) {
    let outcome: ReconciliationOutcome = planned.outcome;
    let artifactId = planned.current?.artifactId;
    let priorVersionId = planned.current?.versionId;
    let versionId: string | undefined;

    if (
      outcome === 'unchanged' &&
      planned.current?.authority === 'manual' &&
      planned.candidate !== undefined &&
      artifactId !== undefined
    ) {
      const [manual] = await input.transaction
        .select()
        .from(processorArtifactManualRevisions)
        .where(
          and(
            eq(processorArtifactManualRevisions.artifactId, artifactId),
            eq(processorArtifactManualRevisions.active, true),
          ),
        )
        .limit(1);
      if (
        manual !== undefined &&
        manual.payloadHash !== planned.candidate.payloadHash
      ) {
        await input.transaction
          .update(processorArtifactCandidates)
          .set({ status: 'superseded', resolvedAt: input.now })
          .where(
            and(
              eq(processorArtifactCandidates.artifactId, artifactId),
              eq(processorArtifactCandidates.status, 'reviewable'),
            ),
          );
        await input.transaction.insert(processorArtifactCandidates).values({
          id: input.createId(),
          artifactId,
          runId: input.run.id,
          sourceResultId: input.result.id,
          processorVersionId: input.run.processorVersionId,
          conflictsWithManualRevisionId: manual.id,
          payload: planned.candidate.payload,
          payloadHash: planned.candidate.payloadHash,
          status: 'reviewable',
          createdAt: input.now,
        });
        await input.transaction
          .update(processorArtifacts)
          .set({
            revision: sql`${processorArtifacts.revision} + 1`,
            updatedAt: input.now,
          })
          .where(eq(processorArtifacts.id, artifactId));
      } else if (manual !== undefined) {
        const resolved = await input.transaction
          .update(processorArtifactCandidates)
          .set({ status: 'superseded', resolvedAt: input.now })
          .where(
            and(
              eq(processorArtifactCandidates.artifactId, artifactId),
              eq(processorArtifactCandidates.status, 'reviewable'),
            ),
          )
          .returning({ id: processorArtifactCandidates.id });
        if (resolved.length > 0) {
          await input.transaction
            .update(processorArtifacts)
            .set({
              revision: sql`${processorArtifacts.revision} + 1`,
              updatedAt: input.now,
            })
            .where(eq(processorArtifacts.id, artifactId));
        }
      }
    }

    if (outcome === 'create' && planned.candidate !== undefined) {
      const [inactive] = await input.transaction
        .select()
        .from(processorArtifacts)
        .where(
          and(
            eq(processorArtifacts.processorId, input.run.processorId),
            eq(
              processorArtifacts.targetJournalDayId,
              input.run.targetJournalDayId,
            ),
            input.run.targetContributionId === null
              ? isNull(processorArtifacts.targetContributionId)
              : eq(
                  processorArtifacts.targetContributionId,
                  input.run.targetContributionId,
                ),
            eq(processorArtifacts.logicalKey, planned.logicalKey),
          ),
        )
        .limit(1)
        .for('update');
      if (inactive === undefined) {
        artifactId = input.createId();
        await input.transaction.insert(processorArtifacts).values({
          id: artifactId,
          processorId: input.run.processorId,
          targetJournalDayId: input.run.targetJournalDayId,
          ...(input.run.targetContributionId === null
            ? {}
            : { targetContributionId: input.run.targetContributionId }),
          logicalKey: planned.logicalKey,
          kind: resultKind(input.definition),
          authority: 'generated',
          active: true,
          createdAt: input.now,
          updatedAt: input.now,
        });
      } else {
        artifactId = inactive.id;
        const [latest] = await input.transaction
          .select()
          .from(processorArtifactVersions)
          .where(eq(processorArtifactVersions.artifactId, inactive.id))
          .orderBy(desc(processorArtifactVersions.revision))
          .limit(1);
        if (latest === undefined)
          throw new ProcessorReconciliationStateError(
            'A stable processor artifact has no immutable history.',
          );
        if (inactive.authority === 'manual') {
          outcome = 'unchanged';
          priorVersionId = latest.id;
        } else {
          outcome =
            latest.processorVersionId === input.run.processorVersionId
              ? 'update'
              : 'supersede';
          priorVersionId = latest.id;
        }
      }
    }

    if (
      (outcome === 'create' ||
        outcome === 'update' ||
        outcome === 'supersede') &&
      planned.candidate !== undefined &&
      artifactId !== undefined
    ) {
      const [latest] = await input.transaction
        .select({ revision: processorArtifactVersions.revision })
        .from(processorArtifactVersions)
        .where(eq(processorArtifactVersions.artifactId, artifactId))
        .orderBy(desc(processorArtifactVersions.revision))
        .limit(1);
      versionId = input.createId();
      const revision = (latest?.revision ?? 0) + 1;
      if (priorVersionId !== undefined) {
        await input.transaction
          .update(processorArtifactVersions)
          .set({ lifecycle: 'superseded', supersededAt: input.now })
          .where(eq(processorArtifactVersions.id, priorVersionId));
      }
      await input.transaction.insert(processorArtifactVersions).values({
        id: versionId,
        artifactId,
        runId: input.run.id,
        sourceResultId: input.result.id,
        processorVersionId: input.run.processorVersionId,
        revision,
        payload: planned.candidate.payload,
        payloadHash: planned.candidate.payloadHash,
        lifecycle: 'active',
        reconciliationOutcome: outcome,
        ...(priorVersionId === undefined
          ? {}
          : { supersedesVersionId: priorVersionId }),
        createdAt: input.now,
      });
      if (priorVersionId !== undefined) {
        await input.transaction
          .update(processorArtifactVersions)
          .set({
            supersededByVersionId: versionId,
          })
          .where(eq(processorArtifactVersions.id, priorVersionId));
      }
      await input.transaction
        .update(processorArtifacts)
        .set({
          active: true,
          revision: sql`${processorArtifacts.revision} + 1`,
          updatedAt: input.now,
        })
        .where(eq(processorArtifacts.id, artifactId));
    } else if (
      outcome === 'remove_supersede' &&
      artifactId !== undefined &&
      priorVersionId !== undefined
    ) {
      await input.transaction
        .update(processorArtifactVersions)
        .set({ lifecycle: 'superseded', supersededAt: input.now })
        .where(eq(processorArtifactVersions.id, priorVersionId));
      await input.transaction
        .update(processorArtifacts)
        .set({
          active: false,
          revision: sql`${processorArtifacts.revision} + 1`,
          updatedAt: input.now,
        })
        .where(eq(processorArtifacts.id, artifactId));
    }

    if (
      artifactId === undefined ||
      (priorVersionId === undefined && outcome !== 'create')
    )
      throw new ProcessorReconciliationStateError(
        'A reconciliation outcome is missing stable artifact history.',
      );
    const [record] = await input.transaction
      .insert(processorReconciliationOutcomes)
      .values({
        runId: input.run.id,
        ordinal,
        logicalKey: planned.logicalKey,
        outcome,
        artifactId,
        ...(versionId === undefined ? {} : { versionId }),
        ...(priorVersionId === undefined ? {} : { priorVersionId }),
        createdAt: input.now,
      })
      .returning();
    if (record === undefined)
      throw new ProcessorReconciliationStateError(
        'Processor reconciliation outcome was not stored.',
      );
    persisted.push(record);
  }
  return Object.freeze({
    reconciliation,
    outcomes: Object.freeze(persisted),
  });
}
