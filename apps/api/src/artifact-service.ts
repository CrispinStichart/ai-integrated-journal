import { createHash } from 'node:crypto';

import {
  artifactApiIdempotency,
  auditEvents,
  inTransaction,
  journalDays,
  processorArtifactCandidates,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorInstallations,
  processorResultEvidence,
  processorResults,
  processorRuns,
  processorVersions,
  transcriptRevisions,
  transcripts,
  type JournalDatabase,
  type JournalTransaction,
} from '@journal/database';
import {
  artifactMutationResponseSchema,
  artifactResourceSchema,
  type ArtifactAddRequest,
  type ArtifactEditRequest,
  type ArtifactMergeRequest,
  type ArtifactResource,
} from '@journal/contracts';
import {
  applyArtifactOverrides,
  assertManualArtifactTargets,
  createUuidV7,
  mergeArtifactOverrides,
  type ArtifactManualOperation,
  type ArtifactOverrideValue,
} from '@journal/domain';
import { and, asc, desc, eq, max, sql } from 'drizzle-orm';

export class ArtifactNotFoundError extends Error {
  public constructor() {
    super('Artifact not found.');
    this.name = 'ArtifactNotFoundError';
  }
}

export class ArtifactConflictError extends Error {
  public constructor(message = 'The artifact has changed.') {
    super(message);
    this.name = 'ArtifactConflictError';
  }
}

export class ArtifactPreconditionError extends Error {
  public constructor() {
    super('The artifact ETag no longer matches the current revision.');
    this.name = 'ArtifactPreconditionError';
  }
}

export interface ArtifactMutationResult {
  readonly artifacts: readonly ArtifactResource[];
  readonly replayed: boolean;
}

export interface ArtifactService {
  list(
    ownerId: string,
    journalDayId: string,
  ): Promise<readonly ArtifactResource[]>;
  add(
    ownerId: string,
    journalDayId: string,
    input: ArtifactAddRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult>;
  edit(
    ownerId: string,
    artifactId: string,
    expectedRevision: number,
    input: ArtifactEditRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult>;
  merge(
    ownerId: string,
    expectedRevisions: Readonly<Record<string, number>>,
    input: ArtifactMergeRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult>;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

async function ownedArtifact(
  transaction: JournalTransaction,
  ownerId: string,
  artifactId: string,
) {
  const [row] = await transaction
    .select({ artifact: processorArtifacts })
    .from(processorArtifacts)
    .innerJoin(
      journalDays,
      eq(journalDays.id, processorArtifacts.targetJournalDayId),
    )
    .where(
      and(
        eq(processorArtifacts.id, artifactId),
        eq(journalDays.userId, ownerId),
      ),
    )
    .limit(1)
    .for('update');
  if (row === undefined) throw new ArtifactNotFoundError();
  return row.artifact;
}

async function resource(
  context: JournalDatabase | JournalTransaction,
  ownerId: string,
  artifactId: string,
): Promise<ArtifactResource> {
  const [row] = await context
    .select({ artifact: processorArtifacts })
    .from(processorArtifacts)
    .innerJoin(
      journalDays,
      eq(journalDays.id, processorArtifacts.targetJournalDayId),
    )
    .where(
      and(
        eq(processorArtifacts.id, artifactId),
        eq(journalDays.userId, ownerId),
      ),
    )
    .limit(1);
  if (row === undefined) throw new ArtifactNotFoundError();
  const generated = await context
    .select()
    .from(processorArtifactVersions)
    .where(eq(processorArtifactVersions.artifactId, artifactId))
    .orderBy(asc(processorArtifactVersions.createdAt));
  const manual = await context
    .select()
    .from(processorArtifactManualRevisions)
    .where(eq(processorArtifactManualRevisions.artifactId, artifactId))
    .orderBy(asc(processorArtifactManualRevisions.createdAt));
  const candidates = await context
    .select()
    .from(processorArtifactCandidates)
    .where(eq(processorArtifactCandidates.artifactId, artifactId))
    .orderBy(
      desc(processorArtifactCandidates.createdAt),
      desc(processorArtifactCandidates.id),
    );
  const candidate = candidates.find(({ status }) => status === 'reviewable');
  const generatedBasis = candidates[0];
  const activeGenerated = generated.find((item) => item.lifecycle === 'active');
  const activeManual = manual.find((item) => item.active);
  const basePayload =
    generatedBasis?.payload ??
    activeGenerated?.payload ??
    activeManual?.payload ??
    {};
  const payload =
    activeManual === undefined
      ? basePayload
      : applyArtifactOverrides(
          basePayload,
          activeManual.overrides as readonly ArtifactOverrideValue[],
        );
  const deleted =
    activeManual?.operation === 'delete' ||
    activeManual?.operation === 'split_source' ||
    activeManual?.operation === 'merge_source';
  const basisResultId =
    activeGenerated?.sourceResultId ?? generatedBasis?.sourceResultId;
  const evidence =
    basisResultId === undefined
      ? []
      : await context
          .select({
            evidence: processorResultEvidence,
            transcriptLayer: transcripts.layer,
          })
          .from(processorResultEvidence)
          .leftJoin(
            processorResults,
            eq(processorResults.id, processorResultEvidence.processorResultId),
          )
          .leftJoin(
            processorArtifactVersions,
            eq(processorArtifactVersions.sourceResultId, processorResults.id),
          )
          .leftJoin(
            transcriptRevisions,
            eq(
              transcriptRevisions.id,
              processorResultEvidence.transcriptRevisionId,
            ),
          )
          .leftJoin(
            transcripts,
            eq(transcripts.id, transcriptRevisions.transcriptId),
          )
          .where(
            and(
              eq(processorResultEvidence.processorResultId, basisResultId),
              eq(processorArtifactVersions.artifactId, artifactId),
            ),
          )
          .orderBy(asc(processorResultEvidence.ordinal));
  const [provenance] =
    basisResultId === undefined
      ? []
      : await context
          .select({
            resultId: processorResults.id,
            runId: processorRuns.id,
            processorKey: processorInstallations.key,
            processorName: processorInstallations.displayName,
            processorVersionId: processorVersions.id,
            semanticVersion: processorVersions.semanticVersion,
            instructionHash: processorVersions.instructionHash,
            promptTemplateHash: processorRuns.promptTemplateHash,
            provider: processorRuns.provider,
            model: processorRuns.model,
            processingTimeMilliseconds:
              processorRuns.processingTimeMilliseconds,
            completedAt: processorRuns.completedAt,
          })
          .from(processorResults)
          .innerJoin(
            processorRuns,
            eq(processorRuns.id, processorResults.runId),
          )
          .innerJoin(
            processorVersions,
            eq(processorVersions.id, processorResults.processorVersionId),
          )
          .innerJoin(
            processorInstallations,
            eq(processorInstallations.id, processorResults.processorId),
          )
          .where(eq(processorResults.id, basisResultId))
          .limit(1);
  return artifactResourceSchema.parse({
    id: row.artifact.id,
    processorId: row.artifact.processorId,
    journalDayId: row.artifact.targetJournalDayId,
    ...(row.artifact.targetContributionId === null
      ? {}
      : { contributionId: row.artifact.targetContributionId }),
    logicalKey: row.artifact.logicalKey,
    kind: row.artifact.kind,
    revision: row.artifact.revision,
    active: row.artifact.active && !deleted,
    deleted,
    authority: activeManual === undefined ? 'generated' : 'manual',
    payload,
    ...(activeManual === undefined
      ? {}
      : {
          manualOperation: activeManual.operation,
          overridePaths: activeManual.overrides.map(({ path }) => path),
        }),
    ...(activeManual === undefined ? { overridePaths: [] } : {}),
    ...(candidate === undefined
      ? {}
      : {
          generatedCandidate: {
            id: candidate.id,
            versionId: candidate.id,
            payload: candidate.payload,
            payloadHash: candidate.payloadHash,
            status: candidate.status,
            conflictsWithManualVersionId:
              candidate.conflictsWithManualRevisionId,
            createdAt: candidate.createdAt.toISOString(),
          },
        }),
    candidates: candidates.map((item) => ({
      id: item.id,
      versionId: item.id,
      payload: item.payload,
      payloadHash: item.payloadHash,
      status: item.status,
      conflictsWithManualVersionId: item.conflictsWithManualRevisionId,
      createdAt: item.createdAt.toISOString(),
    })),
    evidence: evidence.map(({ evidence: item, transcriptLayer }) => ({
      id: item.id,
      ordinal: item.ordinal,
      sourceLabel: item.sourceLabel,
      sourceType:
        item.contributionRevisionId === null
          ? transcriptLayer === 'cleaned'
            ? 'cleaned_transcript'
            : 'corrected_transcript'
          : 'typed_text',
      sourceRevisionId:
        item.contributionRevisionId ?? (item.transcriptRevisionId as string),
      normalization: item.normalization,
      offsetUnit: item.offsetUnit,
      startUtf16: item.startUtf16,
      endUtf16: item.endUtf16,
      quote: item.quote,
      quoteHash: item.quoteHash,
      resolutionStatus: item.resolutionStatus,
      ...(item.unresolvedReason === null
        ? {}
        : { unresolvedReason: item.unresolvedReason }),
      ...(item.startMs === null || item.endMs === null
        ? {}
        : {
            audioRange: {
              startMs: Number(item.startMs),
              endMs: Number(item.endMs),
            },
          }),
    })),
    ...(provenance === undefined
      ? {}
      : {
          provenance: {
            resultId: provenance.resultId,
            runId: provenance.runId,
            processorKey: provenance.processorKey,
            processorName: provenance.processorName,
            processorVersionId: provenance.processorVersionId,
            semanticVersion: provenance.semanticVersion,
            instructionHash: provenance.instructionHash,
            promptTemplateHash: provenance.promptTemplateHash,
            ...(provenance.provider === null
              ? {}
              : { provider: provenance.provider }),
            ...(provenance.model === null ? {} : { model: provenance.model }),
            ...(provenance.processingTimeMilliseconds === null
              ? {}
              : {
                  processingTimeMilliseconds: Number(
                    provenance.processingTimeMilliseconds,
                  ),
                }),
            ...(provenance.completedAt === null
              ? {}
              : { completedAt: provenance.completedAt.toISOString() }),
          },
        }),
    history: [
      ...generated.map((item) => ({
        id: item.id,
        revision: item.revision,
        authority: 'generated' as const,
        lifecycle: item.lifecycle,
        payload: item.payload,
        payloadHash: item.payloadHash,
        processorVersionId: item.processorVersionId,
        sourceResultId: item.sourceResultId,
        overridePaths: [],
        createdAt: item.createdAt.toISOString(),
      })),
      ...manual.map((item) => ({
        id: item.id,
        revision: item.revision,
        authority: 'manual' as const,
        lifecycle: item.active ? ('active' as const) : ('superseded' as const),
        payload: item.payload,
        payloadHash: item.payloadHash,
        manualOperation: item.operation,
        overridePaths: item.overrides.map(({ path }) => path),
        ...(item.staleAt === null
          ? {}
          : { staleAt: item.staleAt.toISOString() }),
        createdAt: item.createdAt.toISOString(),
      })),
    ].sort((left, right) => left.createdAt.localeCompare(right.createdAt)),
    createdAt: row.artifact.createdAt.toISOString(),
    updatedAt: row.artifact.updatedAt.toISOString(),
  });
}

async function appendManualRevision(
  transaction: JournalTransaction,
  input: {
    artifact: typeof processorArtifacts.$inferSelect;
    ownerId: string;
    operation: ArtifactManualOperation;
    payload: Readonly<Record<string, unknown>>;
    overrides: readonly ArtifactOverrideValue[];
    editGroupId: string;
    reason?: string;
    now: Date;
    createId: () => string;
  },
): Promise<void> {
  const [previous] = await transaction
    .select()
    .from(processorArtifactManualRevisions)
    .where(
      and(
        eq(processorArtifactManualRevisions.artifactId, input.artifact.id),
        eq(processorArtifactManualRevisions.active, true),
      ),
    )
    .limit(1);
  const [latest] = await transaction
    .select({ value: max(processorArtifactManualRevisions.revision) })
    .from(processorArtifactManualRevisions)
    .where(eq(processorArtifactManualRevisions.artifactId, input.artifact.id));
  const id = input.createId();
  await transaction.insert(processorArtifactManualRevisions).values({
    id,
    artifactId: input.artifact.id,
    revision: (latest?.value ?? 0) + 1,
    operation: input.operation,
    payload: input.payload,
    payloadHash: hash(input.payload),
    overrides: input.overrides,
    authorId: input.ownerId,
    editGroupId: input.editGroupId,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(previous === undefined
      ? {}
      : {
          active: false,
          supersedesRevisionId: previous.id,
          supersededAt: input.now,
        }),
    createdAt: input.now,
  });
  if (previous !== undefined) {
    await transaction
      .update(processorArtifactManualRevisions)
      .set({
        active: false,
        supersededByRevisionId: id,
        supersededAt: input.now,
      })
      .where(eq(processorArtifactManualRevisions.id, previous.id));
    await transaction
      .update(processorArtifactManualRevisions)
      .set({ active: true, supersededAt: null })
      .where(eq(processorArtifactManualRevisions.id, id));
  }
  await transaction
    .update(processorArtifactCandidates)
    .set({ status: 'superseded', resolvedAt: input.now })
    .where(
      and(
        eq(processorArtifactCandidates.artifactId, input.artifact.id),
        eq(processorArtifactCandidates.status, 'reviewable'),
      ),
    );
  await transaction
    .update(processorArtifacts)
    .set({
      authority: 'manual',
      active: true,
      revision: sql`${processorArtifacts.revision} + 1`,
      updatedAt: input.now,
    })
    .where(eq(processorArtifacts.id, input.artifact.id));
  await transaction.insert(auditEvents).values({
    id: input.createId(),
    action: `artifact.${input.operation}`,
    actorId: input.ownerId,
    entityType: 'processor_artifact',
    entityId: input.artifact.id,
    revisionId: id,
    correlationId: input.editGroupId,
    beforeHash: previous?.payloadHash ?? null,
    afterHash: hash(input.payload),
    metadata: {
      operation: input.operation,
      overrideCount: input.overrides.length,
    },
    occurredAt: input.now,
  });
}

async function replay(
  transaction: JournalTransaction,
  ownerId: string,
  operation: string,
  key: string,
  requestHash: string,
): Promise<ArtifactMutationResult | undefined> {
  const [row] = await transaction
    .select()
    .from(artifactApiIdempotency)
    .where(
      and(
        eq(artifactApiIdempotency.ownerId, ownerId),
        eq(artifactApiIdempotency.operation, operation),
        eq(artifactApiIdempotency.idempotencyKey, key),
      ),
    )
    .limit(1);
  if (row === undefined) return undefined;
  if (row.requestHash !== requestHash)
    throw new ArtifactConflictError(
      'The idempotency key was reused with different artifact input.',
    );
  const parsed = artifactMutationResponseSchema
    .pick({ artifacts: true })
    .parse(row.response);
  return { artifacts: parsed.artifacts, replayed: true };
}

export class PostgresArtifactService implements ArtifactService {
  public constructor(
    private readonly database: JournalDatabase,
    private readonly now: () => Date = () => new Date(),
    private readonly createId: () => string = () =>
      createUuidV7<'artifact-edit'>(),
  ) {}

  public async list(
    ownerId: string,
    journalDayId: string,
  ): Promise<readonly ArtifactResource[]> {
    const days = await this.database
      .select({ id: journalDays.id })
      .from(journalDays)
      .where(
        and(eq(journalDays.id, journalDayId), eq(journalDays.userId, ownerId)),
      )
      .limit(1);
    if (days.length === 0) throw new ArtifactNotFoundError();
    const artifacts = await this.database
      .select({ id: processorArtifacts.id })
      .from(processorArtifacts)
      .where(eq(processorArtifacts.targetJournalDayId, journalDayId))
      .orderBy(asc(processorArtifacts.createdAt), asc(processorArtifacts.id));
    return Promise.all(
      artifacts.map(({ id }) => resource(this.database, ownerId, id)),
    );
  }

  public async add(
    ownerId: string,
    journalDayId: string,
    input: ArtifactAddRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult> {
    const requestHash = hash({ journalDayId, input });
    return inTransaction(this.database, async (transaction) => {
      const operation = `add:${journalDayId}`;
      const priorReplay = await replay(
        transaction,
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
      );
      if (priorReplay !== undefined) return priorReplay;
      const [day] = await transaction
        .select({ id: journalDays.id })
        .from(journalDays)
        .where(
          and(
            eq(journalDays.id, journalDayId),
            eq(journalDays.userId, ownerId),
          ),
        )
        .limit(1)
        .for('update');
      if (day === undefined) throw new ArtifactNotFoundError();
      const [processor] = await transaction
        .select({ id: processorInstallations.id })
        .from(processorInstallations)
        .where(eq(processorInstallations.key, input.processorKey))
        .limit(1);
      if (processor === undefined)
        throw new ArtifactConflictError(
          'The accomplishments processor is not installed.',
        );
      const now = this.now();
      const artifact = {
        id: input.artifactId,
        processorId: processor.id,
        targetJournalDayId: journalDayId,
        targetContributionId: null,
        logicalKey: input.logicalKey,
        kind: input.kind,
        authority: 'manual' as const,
        revision: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      };
      await transaction.insert(processorArtifacts).values(artifact);
      await appendManualRevision(transaction, {
        artifact,
        ownerId,
        operation: 'add',
        payload: input.payload,
        overrides: [{ path: '', value: input.payload }],
        editGroupId: correlationId,
        now,
        createId: this.createId,
      });
      const artifacts = [
        await resource(transaction, ownerId, input.artifactId),
      ];
      const response = artifactMutationResponseSchema
        .pick({ artifacts: true })
        .parse({ artifacts });
      await transaction.insert(artifactApiIdempotency).values({
        ownerId,
        operation,
        idempotencyKey,
        requestHash,
        response,
        createdAt: now,
      });
      return { artifacts: response.artifacts, replayed: false };
    });
  }

  public async edit(
    ownerId: string,
    artifactId: string,
    expectedRevision: number,
    edit: ArtifactEditRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult> {
    const requestHash = hash({ artifactId, edit, expectedRevision });
    return inTransaction(this.database, async (transaction) => {
      const priorReplay = await replay(
        transaction,
        ownerId,
        `edit:${artifactId}`,
        idempotencyKey,
        requestHash,
      );
      if (priorReplay !== undefined) return priorReplay;
      const artifact = await ownedArtifact(transaction, ownerId, artifactId);
      const lockedReplay = await replay(
        transaction,
        ownerId,
        `edit:${artifactId}`,
        idempotencyKey,
        requestHash,
      );
      if (lockedReplay !== undefined) return lockedReplay;
      if (artifact.revision !== expectedRevision)
        throw new ArtifactPreconditionError();
      const now = this.now();
      const before = await resource(transaction, ownerId, artifactId);
      const editGroupId = correlationId;
      const affectedIds = [artifactId];
      if (edit.operation === 'dismiss_candidate') {
        const updated = await transaction
          .update(processorArtifactCandidates)
          .set({ status: 'dismissed', resolvedAt: now })
          .where(
            and(
              eq(processorArtifactCandidates.id, edit.candidateId),
              eq(processorArtifactCandidates.artifactId, artifactId),
              eq(processorArtifactCandidates.status, 'reviewable'),
            ),
          )
          .returning({ id: processorArtifactCandidates.id });
        if (updated.length === 0)
          throw new ArtifactConflictError(
            'The generated candidate is no longer reviewable.',
          );
        await transaction
          .update(processorArtifacts)
          .set({
            revision: sql`${processorArtifacts.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(processorArtifacts.id, artifactId));
        await transaction.insert(auditEvents).values({
          id: this.createId(),
          action: 'artifact.candidate_dismiss',
          actorId: ownerId,
          entityType: 'processor_artifact',
          entityId: artifactId,
          correlationId,
          metadata: { candidateId: edit.candidateId },
          occurredAt: now,
        });
      } else if (edit.operation === 'release_override') {
        const [manual] = await transaction
          .select()
          .from(processorArtifactManualRevisions)
          .where(
            and(
              eq(processorArtifactManualRevisions.artifactId, artifactId),
              eq(processorArtifactManualRevisions.active, true),
            ),
          )
          .limit(1);
        if (manual === undefined)
          throw new ArtifactConflictError(
            'The artifact has no active manual override.',
          );
        await transaction
          .update(processorArtifactManualRevisions)
          .set({ active: false, supersededAt: now })
          .where(eq(processorArtifactManualRevisions.id, manual.id));
        const [generated] = await transaction
          .select()
          .from(processorArtifactVersions)
          .where(
            and(
              eq(processorArtifactVersions.artifactId, artifactId),
              eq(processorArtifactVersions.lifecycle, 'active'),
            ),
          )
          .limit(1);
        await transaction
          .update(processorArtifacts)
          .set({
            authority: 'generated',
            active: generated !== undefined,
            revision: sql`${processorArtifacts.revision} + 1`,
            updatedAt: now,
          })
          .where(eq(processorArtifacts.id, artifactId));
        await transaction.insert(auditEvents).values({
          id: this.createId(),
          action: 'artifact.override_release',
          actorId: ownerId,
          entityType: 'processor_artifact',
          entityId: artifactId,
          revisionId: manual.id,
          correlationId,
          beforeHash: manual.payloadHash,
          metadata: { generatedAvailable: generated !== undefined },
          occurredAt: now,
        });
      } else if (edit.operation === 'split') {
        assertManualArtifactTargets({
          operation: 'split',
          sourceArtifactIds: [artifactId],
          resultCount: edit.results.length,
        });
        await appendManualRevision(transaction, {
          artifact,
          ownerId,
          operation: 'split_source',
          payload: before.payload,
          overrides: [{ path: '', value: before.payload }],
          editGroupId,
          ...(edit.reason === undefined ? {} : { reason: edit.reason }),
          now,
          createId: this.createId,
        });
        for (const result of edit.results) {
          const child = {
            ...artifact,
            id: result.artifactId,
            logicalKey: result.logicalKey,
            authority: 'manual' as const,
            revision: 0,
            createdAt: now,
            updatedAt: now,
          };
          await transaction.insert(processorArtifacts).values({
            id: child.id,
            processorId: child.processorId,
            targetJournalDayId: child.targetJournalDayId,
            ...(child.targetContributionId === null
              ? {}
              : { targetContributionId: child.targetContributionId }),
            logicalKey: child.logicalKey,
            kind: child.kind,
            authority: 'manual',
            revision: 0,
            active: true,
            createdAt: now,
            updatedAt: now,
          });
          await appendManualRevision(transaction, {
            artifact: child,
            ownerId,
            operation: 'split_result',
            payload: result.payload,
            overrides: [{ path: '', value: result.payload }],
            editGroupId,
            ...(edit.reason === undefined ? {} : { reason: edit.reason }),
            now,
            createId: this.createId,
          });
          affectedIds.push(child.id);
        }
      } else {
        let payload: Readonly<Record<string, unknown>> = before.payload;
        let overrides: readonly ArtifactOverrideValue[] = [
          { path: '', value: payload },
        ];
        let operation: ArtifactManualOperation =
          edit.operation === 'delete'
            ? 'delete'
            : edit.operation === 'confirm'
              ? 'confirm'
              : 'correct';
        if (edit.operation === 'correct' || edit.operation === 'pin') {
          if (edit.operation === 'pin') {
            const [processor] = await transaction
              .select({ key: processorInstallations.key })
              .from(processorInstallations)
              .where(eq(processorInstallations.id, artifact.processorId))
              .limit(1);
            if (
              processor?.key !== 'accomplishments' ||
              typeof before.payload.pinned !== 'boolean'
            )
              throw new ArtifactConflictError(
                'Only accomplishment bullets can be pinned.',
              );
          }
          const [previous] = await transaction
            .select()
            .from(processorArtifactManualRevisions)
            .where(
              and(
                eq(processorArtifactManualRevisions.artifactId, artifactId),
                eq(processorArtifactManualRevisions.active, true),
              ),
            )
            .limit(1);
          const requestedOverrides =
            edit.operation === 'pin'
              ? [{ path: '/pinned', value: edit.pinned }]
              : edit.overrides;
          overrides = mergeArtifactOverrides(
            (previous?.overrides ?? []) as readonly ArtifactOverrideValue[],
            requestedOverrides,
          );
          payload = applyArtifactOverrides(before.payload, requestedOverrides);
          if (edit.operation === 'pin') operation = 'pin';
        } else if (edit.operation === 'adopt_candidate') {
          const [candidate] = await transaction
            .select()
            .from(processorArtifactCandidates)
            .where(
              and(
                eq(processorArtifactCandidates.id, edit.candidateId),
                eq(processorArtifactCandidates.artifactId, artifactId),
                eq(processorArtifactCandidates.status, 'reviewable'),
              ),
            )
            .limit(1);
          if (candidate === undefined)
            throw new ArtifactConflictError(
              'The generated candidate is no longer reviewable.',
            );
          payload = candidate.payload;
          overrides = [{ path: '', value: payload }];
          operation = 'confirm';
          await transaction
            .update(processorArtifactCandidates)
            .set({ status: 'adopted', resolvedAt: now })
            .where(eq(processorArtifactCandidates.id, candidate.id));
        }
        await appendManualRevision(transaction, {
          artifact,
          ownerId,
          operation,
          payload,
          overrides,
          editGroupId,
          ...('reason' in edit && edit.reason !== undefined
            ? { reason: edit.reason }
            : {}),
          now,
          createId: this.createId,
        });
      }
      const artifacts = await Promise.all(
        affectedIds.map((id) => resource(transaction, ownerId, id)),
      );
      const response = artifactMutationResponseSchema
        .pick({ artifacts: true })
        .parse({ artifacts });
      await transaction.insert(artifactApiIdempotency).values({
        ownerId,
        operation: `edit:${artifactId}`,
        idempotencyKey,
        requestHash,
        response,
        createdAt: now,
      });
      return { artifacts: response.artifacts, replayed: false };
    });
  }

  public async merge(
    ownerId: string,
    expectedRevisions: Readonly<Record<string, number>>,
    input: ArtifactMergeRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<ArtifactMutationResult> {
    const requestHash = hash({ expectedRevisions, input });
    return inTransaction(this.database, async (transaction) => {
      const priorReplay = await replay(
        transaction,
        ownerId,
        'merge',
        idempotencyKey,
        requestHash,
      );
      if (priorReplay !== undefined) return priorReplay;
      assertManualArtifactTargets({
        operation: 'merge',
        sourceArtifactIds: input.sourceArtifactIds,
        resultCount: 1,
      });
      const sources = [];
      for (const id of [...input.sourceArtifactIds].sort()) {
        const artifact = await ownedArtifact(transaction, ownerId, id);
        sources.push(artifact);
      }
      const lockedReplay = await replay(
        transaction,
        ownerId,
        'merge',
        idempotencyKey,
        requestHash,
      );
      if (lockedReplay !== undefined) return lockedReplay;
      if (
        sources.some(
          (artifact) => artifact.revision !== expectedRevisions[artifact.id],
        )
      )
        throw new ArtifactPreconditionError();
      const first = sources[0];
      if (first === undefined)
        throw new ArtifactConflictError('A merge requires source artifacts.');
      if (
        sources.some(
          (item) =>
            item.processorId !== first.processorId ||
            item.targetJournalDayId !== first.targetJournalDayId ||
            item.targetContributionId !== first.targetContributionId ||
            item.kind !== first.kind,
        )
      )
        throw new ArtifactConflictError(
          'Merged artifacts must share processor, target, and kind.',
        );
      const now = this.now();
      for (const source of sources) {
        const before = await resource(transaction, ownerId, source.id);
        await appendManualRevision(transaction, {
          artifact: source,
          ownerId,
          operation: 'merge_source',
          payload: before.payload,
          overrides: [{ path: '', value: before.payload }],
          editGroupId: correlationId,
          ...(input.reason === undefined ? {} : { reason: input.reason }),
          now,
          createId: this.createId,
        });
      }
      const resultArtifact = {
        ...first,
        id: input.result.artifactId,
        logicalKey: input.result.logicalKey,
        authority: 'manual' as const,
        revision: 0,
        createdAt: now,
        updatedAt: now,
      };
      await transaction.insert(processorArtifacts).values({
        id: resultArtifact.id,
        processorId: resultArtifact.processorId,
        targetJournalDayId: resultArtifact.targetJournalDayId,
        ...(resultArtifact.targetContributionId === null
          ? {}
          : { targetContributionId: resultArtifact.targetContributionId }),
        logicalKey: resultArtifact.logicalKey,
        kind: resultArtifact.kind,
        authority: 'manual',
        revision: 0,
        active: true,
        createdAt: now,
        updatedAt: now,
      });
      await appendManualRevision(transaction, {
        artifact: resultArtifact,
        ownerId,
        operation: 'merge_result',
        payload: input.result.payload,
        overrides: [{ path: '', value: input.result.payload }],
        editGroupId: correlationId,
        ...(input.reason === undefined ? {} : { reason: input.reason }),
        now,
        createId: this.createId,
      });
      const ids = [...input.sourceArtifactIds, resultArtifact.id];
      const artifacts = await Promise.all(
        ids.map((id) => resource(transaction, ownerId, id)),
      );
      const response = artifactMutationResponseSchema
        .pick({ artifacts: true })
        .parse({ artifacts });
      await transaction.insert(artifactApiIdempotency).values({
        ownerId,
        operation: 'merge',
        idempotencyKey,
        requestHash,
        response,
        createdAt: now,
      });
      return { artifacts: response.artifacts, replayed: false };
    });
  }
}
