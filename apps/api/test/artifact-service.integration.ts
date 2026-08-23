import { createHash } from 'node:crypto';

import {
  auditEvents,
  createDatabaseClient,
  inTransaction,
  journalDays,
  migrateDatabase,
  processorArtifactCandidates,
  processorArtifactManualRevisions,
  processorArtifacts,
  processorArtifactVersions,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  reconcileProcessorResult,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  ArtifactPreconditionError,
  PostgresArtifactService,
} from '../src/artifact-service.js';

const sha = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('manual artifact editing persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let service: PostgresArtifactService;
  const ownerId = createUuidV7<'user'>({ timestamp: 700_000 });
  const otherOwnerId = createUuidV7<'user'>({ timestamp: 701_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 702_000 });
  const processorId = createUuidV7<'processor'>({ timestamp: 703_000 });
  const processorVersionId = createUuidV7<'processor-version'>({
    timestamp: 704_000,
  });
  const artifactId = createUuidV7<'artifact'>({ timestamp: 705_000 });
  const now = new Date('2026-08-23T18:00:00.000Z');
  const definition = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor' as const,
    instructions: 'Synthetic behavior-only artifact test.',
    input: {
      scope: 'journal_day' as const,
      selectors: ['typed_text' as const],
    },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: { type: 'object' },
    reconciliation: {
      strategy: 'logical_key' as const,
      logicalKey: 'logicalKey',
    },
    requirementMode: 'optional' as const,
    defaultEnabled: true,
    nudgePolicy: { enabled: false, allowNotApplicable: true },
    capabilityRequirements: ['deterministic' as const],
    allowPartialInputs: false,
    resourceLimits: {
      maxPromptChars: 1024,
      maxInputChars: 4096,
      maxRuntimeMs: 1000,
      maxResultBytes: 4096,
    },
    outputSafety: {
      mode: 'data_only' as const,
      allowCodeExecution: false as const,
      allowToolCalls: false as const,
      allowSql: false as const,
      allowHtml: false as const,
    },
  };

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 8 },
    });
    await migrateDatabase(client.database);
    service = new PostgresArtifactService(client.database, () => now);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Artifact owner' });
    await client.database
      .insert(journalDays)
      .values({ id: dayId, userId: ownerId, journalDate: '2026-08-23' });
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: 'artifact-test',
      displayName: 'Artifact test',
      enabled: true,
      builtIn: false,
      currentVersionId: processorVersionId,
    });
    await client.database.insert(processorVersions).values({
      id: processorVersionId,
      processorId,
      revision: 1,
      semanticVersion: '1.0.0',
      definition,
      instructionHash: sha('instructions'),
      outputSchemaHash: sha('schema'),
      promptTemplateHash: sha('prompt'),
      createdBy: ownerId,
    });
    const runId = createUuidV7<'run'>({ timestamp: 706_000 });
    const resultId = createUuidV7<'result'>({ timestamp: 707_000 });
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId,
      targetScope: 'journal_day',
      targetJournalDayId: dayId,
      attempt: 1,
      status: 'running',
      inputCompleteness: 'complete',
      inputFingerprint: sha('input'),
      promptAssemblyVersion: 'v1',
      promptTemplateHash: sha('prompt'),
      queuedAt: now,
      startedAt: now,
      updatedAt: now,
    });
    await client.database.insert(processorResults).values({
      id: resultId,
      runId,
      processorId,
      processorVersionId,
      targetJournalDayId: dayId,
      kind: 'observation',
      completeness: 'complete',
      payload: {
        items: [{ logicalKey: 'water', amount: 1, context: 'breakfast' }],
      },
      createdAt: now,
      updatedAt: now,
    });
    await client.database.insert(processorArtifacts).values({
      id: artifactId,
      processorId,
      targetJournalDayId: dayId,
      logicalKey: 'string:water',
      kind: 'observation',
      revision: 0,
      authority: 'generated',
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await client.database.insert(processorArtifactVersions).values({
      id: createUuidV7<'version'>({ timestamp: 708_000 }),
      artifactId,
      runId,
      sourceResultId: resultId,
      processorVersionId,
      revision: 1,
      payload: { logicalKey: 'water', amount: 1, context: 'breakfast' },
      payloadHash: sha({
        logicalKey: 'water',
        amount: 1,
        context: 'breakfast',
      }),
      lifecycle: 'active',
      reconciliationOutcome: 'create',
      createdAt: now,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[ARCH-004][EDIT-005][EDIT-006] stores correction and confirmation as immutable manual revisions with idempotent replay', async () => {
    const key = 'artifact-correction-idempotency';
    const correlationId = createUuidV7<'correlation'>({ timestamp: 710_000 });
    const first = await service.edit(
      ownerId,
      artifactId,
      0,
      { operation: 'correct', overrides: [{ path: '/amount', value: 2 }] },
      key,
      correlationId,
    );
    expect(first.replayed).toBe(false);
    expect(first.artifacts[0]).toMatchObject({
      authority: 'manual',
      payload: { logicalKey: 'water', amount: 2, context: 'breakfast' },
      overridePaths: ['/amount'],
    });
    expect(
      (
        await service.edit(
          ownerId,
          artifactId,
          0,
          { operation: 'correct', overrides: [{ path: '/amount', value: 2 }] },
          key,
          correlationId,
        )
      ).replayed,
    ).toBe(true);
    await expect(
      service.edit(
        ownerId,
        artifactId,
        0,
        { operation: 'confirm' },
        'stale-artifact-edit',
        createUuidV7<'correlation'>(),
      ),
    ).rejects.toBeInstanceOf(ArtifactPreconditionError);
    const revisions = await client.database
      .select()
      .from(processorArtifactManualRevisions)
      .where(eq(processorArtifactManualRevisions.artifactId, artifactId));
    expect(revisions).toHaveLength(1);
    const audits = await client.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, artifactId));
    expect(audits[0]).toMatchObject({
      action: 'artifact.correct',
      metadata: { operation: 'correct', overrideCount: 1 },
    });
    expect(JSON.stringify(audits)).not.toContain('breakfast');
  });

  it('[ARCH-004][EDIT-006][EDIT-007][AC-032] reprocessing preserves manual authority and retains a generated conflict candidate', async () => {
    const runId = createUuidV7<'run'>({ timestamp: 720_000 });
    const resultId = createUuidV7<'result'>({ timestamp: 721_000 });
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId,
      targetScope: 'journal_day',
      targetJournalDayId: dayId,
      attempt: 2,
      status: 'running',
      inputCompleteness: 'complete',
      inputFingerprint: sha('input-2'),
      promptAssemblyVersion: 'v1',
      promptTemplateHash: sha('prompt'),
      queuedAt: now,
      startedAt: now,
      updatedAt: now,
    });
    const [result] = await client.database
      .insert(processorResults)
      .values({
        id: resultId,
        runId,
        processorId,
        processorVersionId,
        targetJournalDayId: dayId,
        kind: 'observation',
        completeness: 'complete',
        payload: {
          items: [{ logicalKey: 'water', amount: 3, context: 'lunch' }],
        },
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [run] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, runId));
    if (run === undefined || result === undefined)
      throw new Error('Expected proposal.');
    await inTransaction(client.database, (transaction) =>
      reconcileProcessorResult({
        transaction,
        run,
        result,
        definition,
        now,
        createId: () => createUuidV7<'reconciliation'>(),
      }),
    );
    const [view] = await service.list(ownerId, dayId);
    expect(view).toMatchObject({
      authority: 'manual',
      payload: { amount: 2, context: 'lunch' },
      generatedCandidate: {
        payload: { amount: 3, context: 'lunch' },
        status: 'reviewable',
      },
    });
    expect(
      await client.database.select().from(processorArtifactCandidates),
    ).toHaveLength(1);
  });

  it('[ARCH-004][FOOD-007] confirms, splits, merges, deletes, and releases only through new immutable manual revisions', async () => {
    const current = (await service.list(ownerId, dayId)).find(
      (item) => item.id === artifactId,
    );
    if (current?.generatedCandidate === undefined)
      throw new Error('Expected a manual artifact with a review candidate.');
    const adopted = await service.edit(
      ownerId,
      artifactId,
      current.revision,
      {
        operation: 'adopt_candidate',
        candidateId: current.generatedCandidate.id,
      },
      'adopt-generated-candidate',
      createUuidV7<'correlation'>(),
    );
    expect(adopted.artifacts[0]).toMatchObject({
      authority: 'manual',
      payload: { amount: 3, context: 'lunch' },
      manualOperation: 'confirm',
    });
    const adoptedArtifact = adopted.artifacts[0];
    if (adoptedArtifact === undefined)
      throw new Error('Expected adopted artifact.');
    const split = await service.edit(
      ownerId,
      artifactId,
      adoptedArtifact.revision,
      {
        operation: 'split',
        results: [
          {
            artifactId: createUuidV7<'artifact'>(),
            logicalKey: `manual:split:${createUuidV7()}`,
            payload: { amount: 3 },
          },
          {
            artifactId: createUuidV7<'artifact'>(),
            logicalKey: `manual:split:${createUuidV7()}`,
            payload: { context: 'lunch' },
          },
        ],
      },
      'split-artifact-behavior',
      createUuidV7<'correlation'>(),
    );
    expect(
      split.artifacts.map((item) => [item.manualOperation, item.deleted]),
    ).toEqual([
      ['split_source', true],
      ['split_result', false],
      ['split_result', false],
    ]);
    const children = split.artifacts.slice(1);
    const mergedId = createUuidV7<'artifact'>();
    const merged = await service.merge(
      ownerId,
      Object.fromEntries(children.map((item) => [item.id, item.revision])),
      {
        sourceArtifactIds: children.map((item) => item.id),
        result: {
          artifactId: mergedId,
          logicalKey: `manual:merge:${createUuidV7()}`,
          payload: { amount: 3, context: 'lunch' },
        },
      },
      'merge-artifact-behavior',
      createUuidV7<'correlation'>(),
    );
    expect(merged.artifacts.at(-1)).toMatchObject({
      id: mergedId,
      manualOperation: 'merge_result',
      active: true,
    });
    const mergedArtifact = merged.artifacts.at(-1);
    if (mergedArtifact === undefined)
      throw new Error('Expected merged artifact.');
    const deleted = await service.edit(
      ownerId,
      mergedId,
      mergedArtifact.revision,
      { operation: 'delete' },
      'delete-artifact-behavior',
      createUuidV7<'correlation'>(),
    );
    expect(deleted.artifacts[0]).toMatchObject({
      deleted: true,
      authority: 'manual',
    });
    const deletedArtifact = deleted.artifacts[0];
    if (deletedArtifact === undefined)
      throw new Error('Expected deleted artifact.');
    const released = await service.edit(
      ownerId,
      mergedId,
      deletedArtifact.revision,
      { operation: 'release_override' },
      'release-artifact-override',
      createUuidV7<'correlation'>(),
    );
    expect(released.artifacts[0]).toMatchObject({
      authority: 'generated',
      active: false,
    });
  });

  it('[ARCH-004][SEC-002] serializes competing edits and prevents cross-owner reads', async () => {
    const mergeSources = (await service.list(ownerId, dayId)).filter(
      (item) => item.manualOperation === 'merge_source',
    );
    const child = mergeSources[0];
    const duplicateTarget = mergeSources[1];
    if (child === undefined || duplicateTarget === undefined)
      throw new Error('Expected two merge sources.');
    const duplicateInput = {
      operation: 'correct' as const,
      overrides: [{ path: '/deduplicated', value: true }],
    };
    const duplicateKey = 'concurrent-duplicate-edit';
    const duplicateCorrelation = createUuidV7<'correlation'>();
    const duplicates = await Promise.all([
      service.edit(
        ownerId,
        duplicateTarget.id,
        duplicateTarget.revision,
        duplicateInput,
        duplicateKey,
        duplicateCorrelation,
      ),
      service.edit(
        ownerId,
        duplicateTarget.id,
        duplicateTarget.revision,
        duplicateInput,
        duplicateKey,
        duplicateCorrelation,
      ),
    ]);
    expect(duplicates.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    const results = await Promise.allSettled([
      service.edit(
        ownerId,
        child.id,
        child.revision,
        {
          operation: 'correct',
          overrides: [{ path: '/winner', value: 'left' }],
        },
        'concurrent-left',
        createUuidV7<'correlation'>(),
      ),
      service.edit(
        ownerId,
        child.id,
        child.revision,
        {
          operation: 'correct',
          overrides: [{ path: '/winner', value: 'right' }],
        },
        'concurrent-right',
        createUuidV7<'correlation'>(),
      ),
    ]);
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(
      1,
    );
    expect(results.filter((item) => item.status === 'rejected')).toHaveLength(
      1,
    );
    await expect(service.list(otherOwnerId, dayId)).rejects.toThrow(
      'Artifact not found',
    );
  });
});
