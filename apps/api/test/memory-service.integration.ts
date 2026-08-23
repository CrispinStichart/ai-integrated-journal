import { createHash } from 'node:crypto';

import {
  assembleApprovedTranscriptionContext,
  auditEvents,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  MemoryNotFoundError,
  PostgresMemoryService,
} from '../src/memory-service.js';

const sha = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('feedback and memory persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let service: PostgresMemoryService;
  const ownerId = createUuidV7<'user'>({ timestamp: 800_000 });
  const otherOwnerId = createUuidV7<'user'>({ timestamp: 801_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 802_000 });
  const processorId = createUuidV7<'processor'>({ timestamp: 803_000 });
  const processorVersionId = createUuidV7<'processor-version'>({
    timestamp: 804_000,
  });
  const runId = createUuidV7<'run'>({ timestamp: 805_000 });
  const resultId = createUuidV7<'result'>({ timestamp: 806_000 });
  const correlationId = createUuidV7<'correlation'>({ timestamp: 807_000 });
  const now = new Date('2026-08-23T19:30:00.000Z');
  const definition = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor' as const,
    instructions: 'Synthetic memory target.',
    input: {
      scope: 'journal_day' as const,
      selectors: ['typed_text' as const],
    },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: { type: 'object' },
    reconciliation: { strategy: 'replace_scope' as const },
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
      pool: { max: 5 },
    });
    await migrateDatabase(client.database);
    service = new PostgresMemoryService(client.database, () => now);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Memory owner' });
    await client.database
      .insert(journalDays)
      .values({ id: dayId, userId: ownerId, journalDate: '2026-08-23' });
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: 'memory-target',
      displayName: 'Memory target',
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
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId,
      targetScope: 'journal_day',
      targetJournalDayId: dayId,
      attempt: 1,
      status: 'succeeded',
      inputCompleteness: 'complete',
      inputFingerprint: sha('input'),
      promptAssemblyVersion: 'v1',
      promptTemplateHash: sha('prompt'),
      outputResultId: resultId,
      queuedAt: now,
      startedAt: now,
      completedAt: now,
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
      payload: { synthetic: true },
      createdAt: now,
      updatedAt: now,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[MEM-001][MEM-002][FB-001][FB-002][FB-004][AC-030] keeps ambiguous occurrence feedback local and owner scoped', async () => {
    const saved = await service.createFeedback(
      ownerId,
      {
        mode: 'occurrence_only',
        target: { kind: 'processor_result', id: resultId },
        message: 'This result is only wrong here.',
      },
      'occurrence-only-1',
      correlationId,
    );
    expect(saved.feedback.classifiedScope).toEqual({ kind: 'occurrence_only' });
    expect(saved.memory).toBeUndefined();
    expect((await service.list(ownerId, { limit: 25 })).items).toEqual([]);
    await expect(
      service.createFeedback(
        otherOwnerId,
        {
          mode: 'occurrence_only',
          target: { kind: 'processor_result', id: resultId },
          message: 'Cross-owner probe.',
        },
        'owner-probe-1',
        correlationId,
      ),
    ).rejects.toBeInstanceOf(MemoryNotFoundError);
  });

  it('[MEM-003][MEM-006][MEM-007][FB-003] leaves AI suggestions inactive until explicit approval', async () => {
    const result = await service.createFeedback(
      ownerId,
      {
        mode: 'suggest_memory',
        target: { kind: 'processor_result', id: resultId },
        message: 'This vocabulary may recur.',
        suggestedBy: 'ai',
        memory: {
          type: 'known_entity',
          content: 'Nicolette is a known name.',
          rationale: 'Recurring synthetic correction.',
          scope: { kind: 'global_transcription' },
        },
      },
      'suggestion-1',
      correlationId,
    );
    expect(result.memory?.currentRevision).toMatchObject({
      creator: 'ai',
      approvalState: 'pending',
      enabled: false,
    });
    expect(
      await assembleApprovedTranscriptionContext(client.database, ownerId),
    ).toEqual([]);
    if (result.memory === undefined) throw new Error('Expected suggestion.');
    const approvals = await Promise.all([
      service.mutate(
        ownerId,
        result.memory.id,
        1,
        { operation: 'approve' },
        'approve-1',
        correlationId,
      ),
      service.mutate(
        ownerId,
        result.memory.id,
        1,
        { operation: 'approve' },
        'approve-1',
        correlationId,
      ),
    ]);
    expect(approvals.map(({ replayed }) => replayed).sort()).toEqual([
      false,
      true,
    ]);
    const approved = approvals[0];
    if (approved === undefined) throw new Error('Expected approved memory.');
    expect(approved.memory.currentRevision).toMatchObject({
      approvalState: 'approved',
      enabled: true,
    });
    expect(
      await assembleApprovedTranscriptionContext(client.database, ownerId),
    ).toEqual([
      expect.objectContaining({
        memoryId: approved.memory.id,
        memoryRevisionId: approved.memory.currentRevision.id,
        version: approved.memory.currentRevision.id,
        text: 'Nicolette is a known name.',
      }),
    ]);
  });

  it('[MEM-004][MEM-005][AC-031] searches, revisions, disables, and soft-deletes an explicitly approved memory', async () => {
    const created = await service.createFeedback(
      ownerId,
      {
        mode: 'correct_and_remember',
        target: { kind: 'processor_result', id: resultId },
        message: 'Remember this approved correction.',
        approval: 'approved',
        memory: {
          type: 'application_preference',
          content: 'Prefer concise summaries.',
          rationale: 'Explicit user preference.',
          scope: { kind: 'global_application_preference' },
        },
      },
      'remember-1',
      correlationId,
    );
    if (created.memory === undefined) throw new Error('Expected memory.');
    expect(
      (await service.list(ownerId, { q: 'concise', limit: 25 })).items,
    ).toHaveLength(1);
    const edited = await service.mutate(
      ownerId,
      created.memory.id,
      1,
      {
        operation: 'edit',
        memory: {
          type: 'application_preference',
          content: 'Prefer concise daily summaries.',
          rationale: 'Explicit user preference, clarified.',
          scope: { kind: 'global_application_preference' },
        },
      },
      'edit-1',
      correlationId,
    );
    const disabled = await service.mutate(
      ownerId,
      edited.memory.id,
      2,
      { operation: 'disable' },
      'disable-1',
      correlationId,
    );
    expect(disabled.memory.history.map(({ revision }) => revision)).toEqual([
      3, 2, 1,
    ]);
    expect(
      (await service.list(ownerId, { limit: 25 })).items.map(({ id }) => id),
    ).not.toContain(disabled.memory.id);
    expect(
      (
        await service.list(ownerId, { limit: 25, includeDisabled: true })
      ).items.map(({ id }) => id),
    ).toContain(disabled.memory.id);
    const deleted = await service.mutate(
      ownerId,
      disabled.memory.id,
      3,
      { operation: 'delete' },
      'delete-1',
      correlationId,
    );
    expect(deleted.memory.currentRevision.deletedAt).toBe(now.toISOString());
    expect(
      (
        await service.list(ownerId, { limit: 25, includeDisabled: true })
      ).items.map(({ id }) => id),
    ).not.toContain(deleted.memory.id);
    expect(
      (
        await service.list(ownerId, {
          limit: 25,
          includeDisabled: true,
          includeDeleted: true,
        })
      ).items.map(({ id }) => id),
    ).toContain(deleted.memory.id);
    const events = await client.database
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.entityId, deleted.memory.id));
    expect(JSON.stringify(events)).not.toContain('Prefer concise');
    expect(events.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        'memory.created',
        'memory.edit',
        'memory.disable',
        'memory.delete',
      ]),
    );
  });
});
