import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AiProviderFactoryRegistry } from '@journal/ai';
import type { ProcessorDefinitionDraft } from '@journal/contracts';
import {
  contributionRevisions,
  contributions,
  createDatabaseClient,
  enqueueProcessorRun,
  inTransaction,
  journalDays,
  migrateDatabase,
  processorInstallations,
  processorResultEvidence,
  processorResults,
  processorRunInputs,
  processorRuns,
  processorVersions,
  users,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { LocalBlobStore } from '@journal/storage';
import {
  createDeterministicAiProviderFactory,
  createPostgresTestContainer,
} from '@journal/test-support';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlobRawResponseStore } from '../src/raw-response-store.js';
import { ProcessorJobHandler } from '../src/processor-runtime.js';

function hash(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(value))
    .digest('hex');
}

describe('WORKER generic processor runtime', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let blobRoot: string;
  let blobs: LocalBlobStore;
  let boss: PgBoss;
  let queued: QueueJobPayload | undefined;

  const ownerId = createUuidV7<'user'>({ timestamp: 300_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 301_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 302_000 });
  const revisionId = createUuidV7<'revision'>({ timestamp: 303_000 });
  const processorId = createUuidV7<'processor'>({ timestamp: 304_000 });
  const versionId = createUuidV7<'processor-version'>({ timestamp: 305_000 });
  const deterministicVersionId = createUuidV7<'processor-version'>({
    timestamp: 305_100,
  });
  const timeoutVersionId = createUuidV7<'processor-version'>({
    timestamp: 305_200,
  });
  const now = new Date('2026-08-23T04:00:00.000Z');
  const text = 'Synthetic breakfast note.';

  const definition: ProcessorDefinitionDraft = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor',
    instructions: 'Extract the supported synthetic observation and cite it.',
    input: { scope: 'journal_day', selectors: ['typed_text'] },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['items'],
      properties: {
        items: { type: 'array', maxItems: 4, items: { type: 'string' } },
      },
    },
    reconciliation: { strategy: 'replace_scope' },
    requirementMode: 'optional',
    defaultEnabled: false,
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

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    blobRoot = await mkdtemp(path.join(tmpdir(), 'journal-processor-runtime-'));
    blobs = new LocalBlobStore(blobRoot);
    boss = {
      send: async (
        _name: string,
        payload: object,
        options?: { id?: string },
      ) => {
        queued = payload as QueueJobPayload;
        return options?.id ?? null;
      },
    } as unknown as PgBoss;
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Synthetic processor owner' });
    await client.database
      .insert(journalDays)
      .values({ id: dayId, userId: ownerId, journalDate: '2026-08-22' });
    await client.database.insert(contributions).values({
      id: contributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'typed_text',
      capturedAt: now,
      capturedTimezone: 'Pacific/Auckland',
      journalTimezone: 'America/Los_Angeles',
      journalDateAssignment: 'user_override',
    });
    await client.database.insert(contributionRevisions).values({
      id: revisionId,
      contributionId,
      revision: 1,
      text,
      authority: 'manual',
      authorId: ownerId,
      contentHash: hash(text),
      createdAt: now,
    });
    await client.database
      .update(contributions)
      .set({ currentRevisionId: revisionId, currentRevision: 1 })
      .where(eq(contributions.id, contributionId));
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: 'synthetic-runtime',
      displayName: 'Synthetic runtime',
      purpose: 'Runtime fixture',
      enabled: true,
      builtIn: false,
      currentVersionId: versionId,
    });
    await client.database.insert(processorVersions).values({
      id: versionId,
      processorId,
      revision: 1,
      semanticVersion: definition.semanticVersion,
      definition,
      instructionHash: hash(definition.instructions),
      outputSchemaHash: hash(definition.outputSchema),
      promptTemplateHash: hash({ prompt: 'synthetic' }),
      createdBy: ownerId,
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
    if (blobRoot !== undefined)
      await rm(blobRoot, { recursive: true, force: true });
  });

  it('[ARCH-001][ARCH-003][DATA-031][DATA-032][PROV-001][PROC-004][PROC-007][MODEL-002][STATE-004][STATE-005][TIME-004][SEC-005][SEC-007] stores a validated exact-bound complete result with content-free queue data and full provider lineage', async () => {
    const run = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: versionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        requestedConfiguration: { temperature: 0 },
        now,
      }),
    );
    expect(JSON.stringify(queued)).not.toContain(text);
    expect(queued).toMatchObject({
      operation: 'execute_processor',
      identifiers: {
        runId: run.id,
        processorVersionId: versionId,
        inputKey: run.inputFingerprint,
      },
    });

    const label = `typed_text:${revisionId}`;
    const output = {
      completeness: 'complete',
      payload: { items: ['synthetic observation'] },
      evidence: [
        { sourceLabel: label, startUtf16: 0, endUtf16: 9, quote: 'Synthetic' },
      ],
    } as const;
    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-processor',
        structuredOutput: output,
      }),
    ]);
    const handler = new ProcessorJobHandler(
      client,
      blobs,
      () =>
        registry.resolve(
          { providerId: 'fixture-processor', enabled: true, settings: {} },
          'structured_generation',
        ),
      () => undefined,
      () => now,
    );
    if (queued === undefined) throw new Error('Expected processor work.');
    const canonical = await handler.load(queued);
    if (canonical.input === undefined)
      throw new Error('Expected runnable processor work.');
    expect(canonical.input.bundle.entries[0]).toMatchObject({
      label,
      sourceRevisionId: revisionId,
      temporal: {
        capturedAt: now.toISOString(),
        capturedTimezone: 'Pacific/Auckland',
        journalDate: '2026-08-22',
        journalTimezone: 'America/Los_Angeles',
        journalDateAssignment: 'user_override',
      },
    });
    await handler.execute(canonical.input, new AbortController().signal);

    const [persistedRun] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, run.id));
    const [result] = await client.database
      .select()
      .from(processorResults)
      .where(eq(processorResults.runId, run.id));
    if (result === undefined) throw new Error('Expected processor result.');
    const inputs = await client.database
      .select()
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, run.id));
    const evidence = await client.database
      .select()
      .from(processorResultEvidence)
      .where(eq(processorResultEvidence.processorResultId, result.id));
    expect(persistedRun).toMatchObject({
      status: 'succeeded',
      processorVersionId: versionId,
      inputCompleteness: 'complete',
      provider: { id: 'fixture-processor' },
      model: { id: 'deterministic-structured-v1' },
      requestedConfiguration: { temperature: 0 },
      rawResponseRetention: 'days_30',
    });
    expect(result).toMatchObject({
      processorVersionId: versionId,
      targetJournalDayId: dayId,
      kind: 'observation',
      completeness: 'complete',
      payload: output.payload,
      authority: 'generated',
      manuallyModified: false,
    });
    expect(inputs).toHaveLength(1);
    expect(inputs[0]).toMatchObject({
      label,
      contributionRevisionId: revisionId,
      transcriptRevisionId: null,
      temporalContext: { journalDate: '2026-08-22' },
    });
    expect(evidence[0]).toMatchObject({
      sourceLabel: label,
      contributionRevisionId: revisionId,
      startUtf16: 0,
      endUtf16: 9,
      quote: 'Synthetic',
      resolutionStatus: 'resolved',
    });
    if (persistedRun?.rawResponseId === null || persistedRun === undefined)
      throw new Error('Expected retained provider response.');
    expect(
      new TextDecoder().decode(
        (
          await new BlobRawResponseStore(client.database, blobs).open(
            persistedRun.rawResponseId,
          )
        ).body,
      ),
    ).toContain('synthetic observation');

    const replay = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: versionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        requestedConfiguration: { temperature: 0 },
        now,
      }),
    );
    expect(replay.id).toBe(run.id);
    expect((await handler.load(queued)).state).toBe('already-complete');
  });

  it('[PROC-001][PROC-007][STATE-001] invokes a registered deterministic processor without an external provider or raw response', async () => {
    const deterministicDefinition: ProcessorDefinitionDraft = {
      ...definition,
      semanticVersion: '1.1.0',
      capabilityRequirements: ['deterministic'],
    };
    await client.database.insert(processorVersions).values({
      id: deterministicVersionId,
      processorId,
      revision: 2,
      semanticVersion: deterministicDefinition.semanticVersion,
      definition: deterministicDefinition,
      instructionHash: hash(deterministicDefinition.instructions),
      outputSchemaHash: hash(deterministicDefinition.outputSchema),
      promptTemplateHash: hash({ prompt: 'deterministic' }),
      createdBy: ownerId,
    });
    const run = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: deterministicVersionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        now,
      }),
    );
    if (queued === undefined)
      throw new Error('Expected deterministic processor work.');
    const handler = new ProcessorJobHandler(
      client,
      blobs,
      async () => ({
        status: 'unavailable',
        providerId: 'unused',
        capability: 'structured_generation',
        reason: 'provider_disabled',
      }),
      (candidateVersionId) =>
        candidateVersionId === deterministicVersionId
          ? () => ({
              completeness: 'complete',
              payload: { items: [] },
              evidence: [],
            })
          : undefined,
      () => now,
    );
    const canonical = await handler.load(queued);
    if (canonical.input === undefined)
      throw new Error('Expected runnable deterministic work.');
    await handler.execute(canonical.input, new AbortController().signal);
    const [persisted] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, run.id));
    expect(persisted).toMatchObject({
      status: 'succeeded',
      provider: { id: 'deterministic' },
      model: { id: deterministicVersionId },
      rawResponseId: null,
    });
  });

  it('[STATE-001][STATE-003][STATE-004] bounds processor runtime and persists a retryable stage-specific timeout', async () => {
    const timeoutDefinition: ProcessorDefinitionDraft = {
      ...definition,
      semanticVersion: '1.2.0',
      capabilityRequirements: ['deterministic'],
      resourceLimits: { ...definition.resourceLimits, maxRuntimeMs: 100 },
    };
    await client.database.insert(processorVersions).values({
      id: timeoutVersionId,
      processorId,
      revision: 3,
      semanticVersion: timeoutDefinition.semanticVersion,
      definition: timeoutDefinition,
      instructionHash: hash(timeoutDefinition.instructions),
      outputSchemaHash: hash(timeoutDefinition.outputSchema),
      promptTemplateHash: hash({ prompt: 'timeout' }),
      createdBy: ownerId,
    });
    const run = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: timeoutVersionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        now,
      }),
    );
    if (queued === undefined)
      throw new Error('Expected timeout processor work.');
    const handler = new ProcessorJobHandler(
      client,
      blobs,
      async () => ({
        status: 'unavailable',
        providerId: 'unused',
        capability: 'structured_generation',
        reason: 'provider_disabled',
      }),
      (candidateVersionId) =>
        candidateVersionId === timeoutVersionId
          ? async () => new Promise(() => undefined)
          : undefined,
      () => now,
    );
    const canonical = await handler.load(queued);
    if (canonical.input === undefined)
      throw new Error('Expected runnable timeout work.');
    await expect(
      handler.execute(canonical.input, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'transient' });
    const [persisted] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, run.id));
    expect(persisted).toMatchObject({
      status: 'failed',
      errorCode: 'runtime_timeout',
      errorRetryable: true,
      outputResultId: null,
    });
  });
});
