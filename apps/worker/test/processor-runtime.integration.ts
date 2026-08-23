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
  invalidateProcessorDependents,
  inTransaction,
  journalDays,
  migrateDatabase,
  processorInstallations,
  processorArtifacts,
  processorArtifactVersions,
  processorReconciliationOutcomes,
  processorReconciliations,
  processorResultEvidence,
  processorResults,
  processorRunInputs,
  processorRuns,
  processorVersionDependencies,
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
  const invalidReconciliationVersionId = createUuidV7<'processor-version'>({
    timestamp: 305_300,
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
    const [reconciliation] = await client.database
      .select()
      .from(processorReconciliations)
      .where(eq(processorReconciliations.runId, run.id));
    const [reconciliationOutcome] = await client.database
      .select()
      .from(processorReconciliationOutcomes)
      .where(eq(processorReconciliationOutcomes.runId, run.id));
    expect(reconciliation).toMatchObject({
      strategy: 'replace_scope',
      completeness: 'complete',
      sourceResultId: result.id,
    });
    expect(reconciliationOutcome).toMatchObject({
      logicalKey: 'scope',
      outcome: 'create',
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

  it('[ARCH-003][DATA-031][PROV-002][PROV-004][PROC-007][EDIT-001][EDIT-002][STATE-004][SEC-007] binds exact artifact inputs and transitively stales only recorded downstream results before queuing identifier-only replacement work', async () => {
    const [upstream] = await client.database
      .select()
      .from(processorResults)
      .where(eq(processorResults.processorVersionId, versionId));
    if (upstream === undefined) throw new Error('Expected upstream result.');
    const downstreamProcessorId = createUuidV7<'processor'>({
      timestamp: 306_000,
    });
    const downstreamVersionId = createUuidV7<'processor-version'>({
      timestamp: 307_000,
    });
    const downstreamDefinition: ProcessorDefinitionDraft = {
      ...definition,
      semanticVersion: '2.0.0',
      kind: 'interpretation',
      instructions: 'Interpret only the exact selected upstream artifact.',
      input: { scope: 'journal_day', selectors: ['processor_results'] },
      dependencies: [
        {
          upstreamVersionId: versionId,
          outputSelector: '/items',
          acceptPartial: false,
        },
      ],
      capabilityRequirements: ['deterministic'],
    };
    await client.database.insert(processorInstallations).values({
      id: downstreamProcessorId,
      key: 'synthetic-interpretation',
      displayName: 'Synthetic interpretation',
      purpose: 'Provenance fixture',
      enabled: true,
      builtIn: false,
      currentVersionId: downstreamVersionId,
    });
    await client.database.insert(processorVersions).values({
      id: downstreamVersionId,
      processorId: downstreamProcessorId,
      revision: 1,
      semanticVersion: downstreamDefinition.semanticVersion,
      definition: downstreamDefinition,
      instructionHash: hash(downstreamDefinition.instructions),
      outputSchemaHash: hash(downstreamDefinition.outputSchema),
      promptTemplateHash: hash({ prompt: 'downstream' }),
      createdBy: ownerId,
    });
    await client.database.insert(processorVersionDependencies).values({
      processorVersionId: downstreamVersionId,
      upstreamVersionId: versionId,
      outputSelector: '/items',
      acceptPartial: false,
    });
    const downstreamRun = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: downstreamVersionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        now,
      }),
    );
    const downstreamHandler = new ProcessorJobHandler(
      client,
      blobs,
      async () => ({
        status: 'unavailable',
        providerId: 'unused',
        capability: 'structured_generation',
        reason: 'provider_disabled',
      }),
      (candidateVersionId) =>
        candidateVersionId === downstreamVersionId
          ? () => ({
              completeness: 'complete',
              payload: { items: ['synthetic interpretation'] },
              evidence: [],
            })
          : undefined,
      () => now,
    );
    if (queued === undefined) throw new Error('Expected downstream work.');
    const canonical = await downstreamHandler.load(queued);
    if (canonical.input === undefined)
      throw new Error('Expected runnable downstream work.');
    expect(canonical.input.sources[0]).toMatchObject({
      processorResultId: upstream.id,
      outputSelector: '/items',
    });
    await downstreamHandler.execute(
      canonical.input,
      new AbortController().signal,
    );
    const [downstreamResult] = await client.database
      .select()
      .from(processorResults)
      .where(eq(processorResults.runId, downstreamRun.id));
    if (downstreamResult === undefined)
      throw new Error('Expected downstream result.');
    const [artifactBinding] = await client.database
      .select()
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, downstreamRun.id));
    expect(artifactBinding).toMatchObject({
      processorResultId: upstream.id,
      outputSelector: '/items',
    });

    const replacementRevisionId = createUuidV7<'revision'>({
      timestamp: 308_000,
    });
    const invalidation = await inTransaction(
      client.database,
      async (transaction) => {
        const replacementText = 'Synthetic revised breakfast note.';
        await transaction.insert(contributionRevisions).values({
          id: replacementRevisionId,
          contributionId,
          revision: 2,
          text: replacementText,
          authority: 'manual',
          authorId: ownerId,
          contentHash: hash(replacementText),
          createdAt: now,
        });
        await transaction
          .update(contributions)
          .set({ currentRevisionId: replacementRevisionId, currentRevision: 2 })
          .where(eq(contributions.id, contributionId));
        return invalidateProcessorDependents({
          boss,
          transaction,
          changedInput: { kind: 'contribution_revision', id: revisionId },
          now,
        });
      },
    );
    expect(invalidation.staleResultIds).toEqual(
      expect.arrayContaining([upstream.id, downstreamResult.id]),
    );
    expect(invalidation.replacementRunIds).toHaveLength(1);
    const stale = await client.database
      .select()
      .from(processorResults)
      .where(eq(processorResults.staleReason, 'input_revision_superseded'));
    expect(stale.map(({ id }) => id)).toEqual(
      expect.arrayContaining([upstream.id, downstreamResult.id]),
    );
    const [replacementInput] = await client.database
      .select()
      .from(processorRunInputs)
      .where(
        eq(
          processorRunInputs.runId,
          invalidation.replacementRunIds[0] as string,
        ),
      );
    expect(replacementInput?.contributionRevisionId).toBe(
      replacementRevisionId,
    );
    expect(JSON.stringify(queued)).not.toContain('Synthetic revised');

    if (queued === undefined) throw new Error('Expected upstream replacement.');
    const replacementRegistry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-replacement',
        structuredOutput: {
          completeness: 'complete',
          payload: { items: ['replacement observation'] },
          evidence: [],
        },
      }),
    ]);
    const replacementHandler = new ProcessorJobHandler(
      client,
      blobs,
      () =>
        replacementRegistry.resolve(
          { providerId: 'fixture-replacement', enabled: true, settings: {} },
          'structured_generation',
        ),
      () => undefined,
      () => now,
      () => createUuidV7<'processor-runtime'>(),
      boss,
    );
    const replacement = await replacementHandler.load(queued);
    if (replacement.input === undefined)
      throw new Error('Expected runnable upstream replacement.');
    await replacementHandler.execute(
      replacement.input,
      new AbortController().signal,
    );
    const [replacementResult] = await client.database
      .select()
      .from(processorResults)
      .where(
        eq(processorResults.runId, invalidation.replacementRunIds[0] as string),
      );
    if (replacementResult === undefined)
      throw new Error('Expected replacement result.');
    const [replacementOutcome] = await client.database
      .select()
      .from(processorReconciliationOutcomes)
      .where(
        eq(
          processorReconciliationOutcomes.runId,
          invalidation.replacementRunIds[0] as string,
        ),
      );
    expect(replacementOutcome).toMatchObject({
      logicalKey: 'scope',
      outcome: 'update',
    });
    const [stableUpstream] = await client.database
      .select()
      .from(processorArtifacts)
      .where(eq(processorArtifacts.processorId, processorId));
    if (stableUpstream === undefined)
      throw new Error('Expected stable upstream artifact.');
    expect(
      await client.database
        .select()
        .from(processorArtifactVersions)
        .where(eq(processorArtifactVersions.artifactId, stableUpstream.id)),
    ).toHaveLength(2);
    const [queuedDownstream] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.processorVersionId, downstreamVersionId))
      .orderBy(processorRuns.attempt);
    const downstreamReplacement = (
      await client.database
        .select()
        .from(processorRuns)
        .where(eq(processorRuns.processorVersionId, downstreamVersionId))
        .orderBy(processorRuns.attempt)
    ).at(-1);
    expect(queuedDownstream?.attempt).toBe(1);
    expect(downstreamReplacement).toMatchObject({
      attempt: 2,
      status: 'queued',
    });
    const [downstreamReplacementInput] = await client.database
      .select()
      .from(processorRunInputs)
      .where(eq(processorRunInputs.runId, downstreamReplacement?.id as string));
    expect(downstreamReplacementInput).toMatchObject({
      processorResultId: replacementResult.id,
      outputSelector: '/items',
    });
    expect(JSON.stringify(queued)).not.toContain('replacement observation');
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

  it('[PROC-005][STATE-003][STATE-004] rejects an unstable logical key as a permanent reconciliation failure', async () => {
    const logicalDefinition: ProcessorDefinitionDraft = {
      ...definition,
      semanticVersion: '1.3.0',
      outputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['logicalKey'],
              properties: { logicalKey: { type: 'string' } },
            },
          },
        },
      },
      reconciliation: {
        strategy: 'logical_key',
        logicalKey: 'logicalKey',
      },
      capabilityRequirements: ['deterministic'],
    };
    await client.database.insert(processorVersions).values({
      id: invalidReconciliationVersionId,
      processorId,
      revision: 4,
      semanticVersion: logicalDefinition.semanticVersion,
      definition: logicalDefinition,
      instructionHash: hash(logicalDefinition.instructions),
      outputSchemaHash: hash(logicalDefinition.outputSchema),
      promptTemplateHash: hash({ prompt: 'invalid-reconciliation' }),
      createdBy: ownerId,
    });
    const run = await inTransaction(client.database, (transaction) =>
      enqueueProcessorRun({
        boss,
        transaction,
        processorVersionId: invalidReconciliationVersionId,
        target: { scope: 'journal_day', journalDayId: dayId },
        now,
      }),
    );
    if (queued === undefined)
      throw new Error('Expected invalid reconciliation processor work.');
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
        candidateVersionId === invalidReconciliationVersionId
          ? () => ({
              completeness: 'complete',
              payload: { items: [{ logicalKey: '' }] },
              evidence: [],
            })
          : undefined,
      () => now,
    );
    const canonical = await handler.load(queued);
    if (canonical.input === undefined)
      throw new Error('Expected runnable invalid reconciliation work.');
    await expect(
      handler.execute(canonical.input, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'permanent' });
    const [persisted] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, run.id));
    expect(persisted).toMatchObject({
      status: 'failed',
      errorCode: 'invalid_reconciliation_output',
      errorRetryable: false,
      outputResultId: null,
    });
    expect(
      await client.database
        .select()
        .from(processorReconciliations)
        .where(eq(processorReconciliations.runId, run.id)),
    ).toEqual([]);
  });
});
