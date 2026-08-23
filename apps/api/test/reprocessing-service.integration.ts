import { createHash } from 'node:crypto';

import type { ProcessorDefinitionDraft } from '@journal/contracts';
import {
  auditEvents,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorInstallations,
  processorResults,
  ProcessorRuntimeRepository,
  processorRuns,
  processorVersions,
  reprocessingBatchItems,
  reprocessingBatches,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresReprocessingService,
  ReprocessingConflictError,
  ReprocessingNotFoundError,
} from '../src/reprocessing-service.js';

function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

describe('reprocessing orchestration persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let service: PostgresReprocessingService;
  let startedBatchId: string;
  const queuedJobIds: string[] = [];
  const ownerId = createUuidV7<'user'>({ timestamp: 700_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 701_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 702_000 });
  const revisionId = createUuidV7<'revision'>({ timestamp: 703_000 });
  const processorId = createUuidV7<'processor'>({ timestamp: 704_000 });
  const versionId = createUuidV7<'processor-version'>({ timestamp: 705_000 });
  const contributionProcessorId = createUuidV7<'processor'>({
    timestamp: 705_100,
  });
  const contributionVersionId = createUuidV7<'processor-version'>({
    timestamp: 705_200,
  });
  const priorRunId = createUuidV7<'processor-run'>({ timestamp: 706_000 });
  const priorResultId = createUuidV7<'processor-result'>({
    timestamp: 707_000,
  });
  const artifactId = createUuidV7<'artifact'>({ timestamp: 708_000 });
  const artifactVersionId = createUuidV7<'artifact-version'>({
    timestamp: 709_000,
  });
  const manualRevisionId = createUuidV7<'manual-revision'>({
    timestamp: 710_000,
  });
  const correlationId = createUuidV7<'correlation'>({ timestamp: 711_000 });
  const now = new Date('2026-08-23T12:00:00.000Z');
  const source = 'Synthetic private journal fixture.';
  const definition: ProcessorDefinitionDraft = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor',
    instructions: 'Return grounded fixture observations.',
    input: { scope: 'journal_day', selectors: ['typed_text'] },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: { items: { type: 'array', items: { type: 'string' } } },
      required: ['items'],
    },
    reconciliation: { strategy: 'replace_scope' },
    requirementMode: 'optional',
    defaultEnabled: true,
    nudgePolicy: { enabled: false, allowNotApplicable: true },
    capabilityRequirements: ['structured_generation'],
    allowPartialInputs: false,
    resourceLimits: {
      maxPromptChars: 1024,
      maxInputChars: 4096,
      maxRuntimeMs: 5_000,
      maxResultBytes: 4096,
    },
    outputSafety: {
      mode: 'data_only',
      allowCodeExecution: false,
      allowToolCalls: false,
      allowSql: false,
      allowHtml: false,
    },
  };
  const contributionDefinition: ProcessorDefinitionDraft = {
    ...definition,
    semanticVersion: '2.0.0',
    input: { scope: 'contribution', selectors: ['typed_text'] },
    capabilityRequirements: ['deterministic'],
  };

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    const boss = {
      send: async (
        _queue: string,
        _payload: object,
        options?: { id?: string },
      ) => {
        if (options?.id !== undefined) queuedJobIds.push(options.id);
        return options?.id ?? null;
      },
    } as unknown as PgBoss;
    service = new PostgresReprocessingService(client.database, boss, () => now);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Reprocessing owner',
    });
    await client.database.insert(journalDays).values({
      id: dayId,
      userId: ownerId,
      journalDate: '2026-08-23',
    });
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'typed_text',
      capturedAt: now,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(contributionRevisions).values({
      id: revisionId,
      contributionId,
      revision: 1,
      text: source,
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash(source),
      createdAt: now,
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: 'reprocessing-fixture',
      displayName: 'Reprocessing fixture',
      purpose: 'Reprocessing integration behavior.',
      enabled: true,
      builtIn: false,
    });
    await client.database.insert(processorVersions).values({
      id: versionId,
      processorId,
      revision: 1,
      semanticVersion: definition.semanticVersion,
      definition,
      instructionHash: hash(definition.instructions),
      outputSchemaHash: hash(definition.outputSchema),
      promptTemplateHash: hash({ prompt: 'fixture' }),
      createdBy: ownerId,
      createdAt: now,
    });
    await client.database
      .update(processorInstallations)
      .set({ currentVersionId: versionId })
      .where(eq(processorInstallations.id, processorId));
    await client.database.insert(processorInstallations).values({
      id: contributionProcessorId,
      key: 'contribution-reprocessing-fixture',
      displayName: 'Contribution fixture',
      purpose: 'Contribution-scope reprocessing behavior.',
      enabled: true,
      builtIn: false,
    });
    await client.database.insert(processorVersions).values({
      id: contributionVersionId,
      processorId: contributionProcessorId,
      revision: 1,
      semanticVersion: contributionDefinition.semanticVersion,
      definition: contributionDefinition,
      instructionHash: hash(contributionDefinition.instructions),
      outputSchemaHash: hash(contributionDefinition.outputSchema),
      promptTemplateHash: hash({ prompt: 'contribution-fixture' }),
      createdBy: ownerId,
      createdAt: now,
    });
    await client.database
      .update(processorInstallations)
      .set({ currentVersionId: contributionVersionId })
      .where(eq(processorInstallations.id, contributionProcessorId));
    await client.database.insert(processorRuns).values({
      id: priorRunId,
      processorId,
      processorVersionId: versionId,
      targetScope: 'journal_day',
      targetJournalDayId: dayId,
      attempt: 1,
      status: 'running',
      inputCompleteness: 'complete',
      inputFingerprint: '1'.repeat(64),
      promptAssemblyVersion: 'processor-runtime-v1',
      promptTemplateHash: hash({ prompt: 'fixture' }),
      requestedConfiguration: {},
      queuedAt: now,
      startedAt: now,
      updatedAt: now,
    });
    await client.database.insert(processorResults).values({
      id: priorResultId,
      runId: priorRunId,
      processorId,
      processorVersionId: versionId,
      targetJournalDayId: dayId,
      kind: 'observation',
      completeness: 'complete',
      payload: { items: ['fixture'] },
      staleAt: now,
      staleReason: 'input_revision_superseded',
      createdAt: now,
      updatedAt: now,
    });
    await client.database
      .update(processorRuns)
      .set({
        status: 'succeeded',
        outputResultId: priorResultId,
        completedAt: now,
      })
      .where(eq(processorRuns.id, priorRunId));
    await client.database.insert(processorArtifacts).values({
      id: artifactId,
      processorId,
      targetJournalDayId: dayId,
      logicalKey: 'fixture',
      kind: 'observation',
      authority: 'manual',
      revision: 1,
      createdAt: now,
      updatedAt: now,
    });
    await client.database.insert(processorArtifactVersions).values({
      id: artifactVersionId,
      artifactId,
      runId: priorRunId,
      sourceResultId: priorResultId,
      processorVersionId: versionId,
      revision: 1,
      payload: { value: 'generated' },
      payloadHash: hash({ value: 'generated' }),
      reconciliationOutcome: 'create',
      createdAt: now,
    });
    await client.database.insert(processorArtifactManualRevisions).values({
      id: manualRevisionId,
      artifactId,
      revision: 1,
      operation: 'correct',
      payload: { value: 'manual' },
      payloadHash: hash({ value: 'manual' }),
      overrides: [{ path: '/value', value: 'manual' }],
      authorId: ownerId,
      editGroupId: createUuidV7<'edit-group'>({ timestamp: 712_000 }),
      createdAt: now,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[EDIT-003][EDIT-004][EDIT-006][EDIT-008] previews exact immutable semantics, stale impact, manual authority, and provider operations without scheduling', async () => {
    const request = {
      target: { scope: 'journal_day' as const, journalDate: '2026-08-23' },
      versionBasis: {
        mode: 'pinned' as const,
        processorVersionIds: [versionId],
      },
    };
    const preview = await service.preview(ownerId, request);
    expect(preview).toMatchObject({
      versionBasis: {
        mode: 'pinned',
        versions: [{ processorVersionId: versionId, semanticVersion: '1.0.0' }],
      },
      impact: {
        journalDayCount: 1,
        contributionCount: 1,
        runCount: 1,
        approximateProviderOperationCount: 1,
        staleArtifactCount: 1,
        manualOverrideCount: 1,
      },
    });
    expect(preview.warnings.join(' ')).toContain('remain authoritative');
    expect(queuedJobIds).toEqual([]);
  });

  it('[EDIT-003][EDIT-004] resolves contribution, date-range, processor, and processor-version scopes against compatible exact versions', async () => {
    const contribution = await service.preview(ownerId, {
      target: { scope: 'contribution', contributionId },
      versionBasis: {
        mode: 'pinned',
        processorVersionIds: [contributionVersionId],
      },
    });
    expect(contribution).toMatchObject({
      impact: { runCount: 1, journalDayCount: 1, contributionCount: 1 },
      versionBasis: {
        versions: [
          {
            processorVersionId: contributionVersionId,
            inputScope: 'contribution',
          },
        ],
      },
    });
    const dateRange = await service.preview(ownerId, {
      target: {
        scope: 'date_range',
        startDate: '2026-08-23',
        endDate: '2026-08-23',
      },
      versionBasis: { mode: 'current' },
    });
    expect(dateRange.impact).toMatchObject({ runCount: 2 });
    const processor = await service.preview(ownerId, {
      target: {
        scope: 'processor',
        processorId,
        startDate: '2026-08-23',
        endDate: '2026-08-23',
      },
      versionBasis: { mode: 'current' },
    });
    expect(
      processor.versionBasis.versions.map(({ processorId }) => processorId),
    ).toEqual([processorId]);
    const processorVersion = await service.preview(ownerId, {
      target: {
        scope: 'processor_version',
        processorVersionId: versionId,
        startDate: '2026-08-23',
        endDate: '2026-08-23',
      },
      versionBasis: {
        mode: 'pinned',
        processorVersionIds: [versionId],
      },
    });
    expect(processorVersion.versionBasis.versions[0]?.processorVersionId).toBe(
      versionId,
    );
  });

  it('[STATE-001][STATE-004][EDIT-005] transactionally creates a linked new attempt, audits it, and idempotently replays confirmation', async () => {
    const request = {
      target: { scope: 'journal_day' as const, journalDate: '2026-08-23' },
      versionBasis: {
        mode: 'pinned' as const,
        processorVersionIds: [versionId],
      },
    };
    const preview = await service.preview(ownerId, request);
    const first = await service.start(
      ownerId,
      request,
      preview.impactFingerprint,
      'reprocessing-start-1',
      correlationId,
    );
    const replay = await service.start(
      ownerId,
      request,
      preview.impactFingerprint,
      'reprocessing-start-1',
      correlationId,
    );
    expect(first).toMatchObject({
      replayed: false,
      batch: { status: 'queued' },
    });
    startedBatchId = first.batch.id;
    expect(replay).toMatchObject({
      replayed: true,
      batch: { id: first.batch.id },
    });
    const items = await client.database
      .select()
      .from(reprocessingBatchItems)
      .where(eq(reprocessingBatchItems.batchId, first.batch.id));
    expect(items).toHaveLength(1);
    const [run] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, items[0]?.runId ?? ''));
    expect(run).toMatchObject({
      predecessorRunId: priorRunId,
      attempt: 2,
      processorVersionId: versionId,
    });
    expect(queuedJobIds).toEqual([run?.id]);
    const audit = await client.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, first.batch.id));
    expect(audit.map(({ action }) => action)).toContain('reprocessing.started');
    expect(JSON.stringify(audit)).not.toContain(source);
  });

  it('[STATE-004] serializes concurrent confirmation replay into one batch and one exact run', async () => {
    const request = {
      target: {
        scope: 'contribution' as const,
        contributionId,
      },
      versionBasis: {
        mode: 'pinned' as const,
        processorVersionIds: [contributionVersionId],
      },
    };
    const preview = await service.preview(ownerId, request);
    const [left, right] = await Promise.all([
      service.start(
        ownerId,
        request,
        preview.impactFingerprint,
        'reprocessing-concurrent-1',
        correlationId,
      ),
      service.start(
        ownerId,
        request,
        preview.impactFingerprint,
        'reprocessing-concurrent-1',
        correlationId,
      ),
    ]);
    expect(left.batch.id).toBe(right.batch.id);
    expect([left.replayed, right.replayed].sort()).toEqual([false, true]);
    expect(
      await client.database
        .select()
        .from(reprocessingBatchItems)
        .where(eq(reprocessingBatchItems.batchId, left.batch.id)),
    ).toHaveLength(1);
  });

  it('[STATE-001][STATE-004][SEC-001] enforces ownership and conditional cancellation while preserving completed history', async () => {
    const [stored] = await client.database
      .select()
      .from(reprocessingBatches)
      .where(eq(reprocessingBatches.id, startedBatchId));
    if (stored === undefined) throw new Error('Expected reprocessing batch.');
    await expect(
      service.get(
        createUuidV7<'other-owner'>({ timestamp: 799_000 }),
        stored.id,
      ),
    ).rejects.toBeInstanceOf(ReprocessingNotFoundError);
    await expect(
      service.cancel(
        ownerId,
        stored.id,
        99,
        'reprocessing-cancel-stale',
        correlationId,
      ),
    ).rejects.toBeInstanceOf(ReprocessingConflictError);
    const canceled = await service.cancel(
      ownerId,
      stored.id,
      1,
      'reprocessing-cancel-1',
      correlationId,
    );
    expect(canceled.batch).toMatchObject({
      revision: 2,
      status: 'canceled',
      progress: { canceled: 1, percent: 100 },
    });
    const [item] = await client.database
      .select()
      .from(reprocessingBatchItems)
      .where(eq(reprocessingBatchItems.batchId, stored.id));
    if (item === undefined) throw new Error('Expected reprocessing item.');
    const runtime = new ProcessorRuntimeRepository(client.database);
    expect(await runtime.markRunning(item.runId, now)).toBe(false);
    await runtime.markFailed(item.runId, 'late_provider_failure', true, now);
    const [canceledRun] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, item.runId));
    expect(canceledRun?.status).toBe('canceled');
    const [prior] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, priorRunId));
    expect(prior?.status).toBe('succeeded');
  });
});
