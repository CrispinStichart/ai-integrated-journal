import { createHash } from 'node:crypto';

import type { ProcessorDefinitionDraft } from '@journal/contracts';
import {
  createDatabaseClient,
  inTransaction,
  journalDays,
  migrateDatabase,
  processorArtifacts,
  processorArtifactVersions,
  processorInstallations,
  processorReconciliationOutcomes,
  processorReconciliations,
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

function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('processor reconciliation persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;

  const ownerId = createUuidV7<'user'>({ timestamp: 500_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 501_000 });
  const processorId = createUuidV7<'processor'>({ timestamp: 502_000 });
  const versionOneId = createUuidV7<'processor-version'>({
    timestamp: 503_000,
  });
  const versionTwoId = createUuidV7<'processor-version'>({
    timestamp: 504_000,
  });
  const now = new Date('2026-08-23T16:00:00.000Z');

  const definition: ProcessorDefinitionDraft = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor',
    instructions: 'Reconcile synthetic items by their supplied stable key.',
    input: { scope: 'journal_day', selectors: ['typed_text'] },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
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
            required: ['logicalKey', 'value'],
            properties: {
              logicalKey: { type: 'string' },
              value: { type: 'number' },
            },
          },
        },
      },
    },
    reconciliation: { strategy: 'logical_key', logicalKey: 'logicalKey' },
    requirementMode: 'optional',
    defaultEnabled: false,
    nudgePolicy: { enabled: false, allowNotApplicable: true },
    capabilityRequirements: ['deterministic'],
    allowPartialInputs: false,
    resourceLimits: {
      maxPromptChars: 1024,
      maxInputChars: 4096,
      maxRuntimeMs: 5000,
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
      pool: { max: 8 },
    });
    await migrateDatabase(client.database);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Synthetic reconciliation owner',
    });
    await client.database.insert(journalDays).values({
      id: dayId,
      userId: ownerId,
      journalDate: '2026-08-23',
    });
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key: 'synthetic-reconciliation',
      displayName: 'Synthetic reconciliation',
      enabled: true,
      builtIn: false,
      currentVersionId: versionTwoId,
    });
    await client.database.insert(processorVersions).values([
      {
        id: versionOneId,
        processorId,
        revision: 1,
        semanticVersion: '1.0.0',
        definition,
        instructionHash: hash(definition.instructions),
        outputSchemaHash: hash(definition.outputSchema),
        promptTemplateHash: hash('prompt-v1'),
        createdBy: ownerId,
      },
      {
        id: versionTwoId,
        processorId,
        revision: 2,
        semanticVersion: '2.0.0',
        definition: { ...definition, semanticVersion: '2.0.0' },
        instructionHash: hash(definition.instructions),
        outputSchemaHash: hash(definition.outputSchema),
        promptTemplateHash: hash('prompt-v2'),
        createdBy: ownerId,
      },
    ]);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  async function storeProposal(input: {
    attempt: number;
    processorVersionId: string;
    payload: Readonly<Record<string, unknown>>;
    completeness?: 'complete' | 'partial';
    timestamp: number;
  }) {
    const runId = createUuidV7<'processor-run'>({ timestamp: input.timestamp });
    const resultId = createUuidV7<'processor-result'>({
      timestamp: input.timestamp + 1,
    });
    const completeness = input.completeness ?? 'complete';
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId: input.processorVersionId,
      targetScope: 'journal_day',
      targetJournalDayId: dayId,
      attempt: input.attempt,
      status: 'running',
      inputCompleteness: completeness,
      inputFingerprint: hash({ runId }),
      promptAssemblyVersion: 'processor-runtime-v1',
      promptTemplateHash: hash({
        processorVersionId: input.processorVersionId,
      }),
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
        processorVersionId: input.processorVersionId,
        targetJournalDayId: dayId,
        kind: 'observation',
        completeness,
        payload: input.payload,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    const [run] = await client.database
      .select()
      .from(processorRuns)
      .where(eq(processorRuns.id, runId));
    if (run === undefined || result === undefined)
      throw new Error('Expected a stored synthetic proposal.');
    return { run, result };
  }

  async function reconcile(
    proposal: Awaited<ReturnType<typeof storeProposal>>,
    candidateDefinition = definition,
  ) {
    return inTransaction(client.database, (transaction) =>
      reconcileProcessorResult({
        transaction,
        ...proposal,
        definition: candidateDefinition,
        now,
        createId: () => createUuidV7<'reconciliation'>(),
      }),
    );
  }

  it('[PROC-005][EDIT-005][STATE-004] durably records create, update, supersede, remove/supersede, and unchanged outcomes without duplicating stable artifacts', async () => {
    const first = await storeProposal({
      attempt: 1,
      processorVersionId: versionOneId,
      payload: {
        items: [
          { logicalKey: 'a', value: 1 },
          { logicalKey: 'b', value: 1 },
          { logicalKey: 'c', value: 1 },
        ],
      },
      timestamp: 510_000,
    });
    expect(
      (await reconcile(first)).outcomes.map(({ outcome }) => outcome),
    ).toEqual(['create', 'create', 'create']);

    const second = await storeProposal({
      attempt: 2,
      processorVersionId: versionOneId,
      payload: {
        items: [
          { logicalKey: 'a', value: 1 },
          { logicalKey: 'b', value: 2 },
          { logicalKey: 'c', value: 2 },
          { logicalKey: 'd', value: 1 },
        ],
      },
      timestamp: 520_000,
    });
    expect(
      (await reconcile(second)).outcomes.map(({ outcome }) => outcome),
    ).toEqual(['unchanged', 'update', 'update', 'create']);

    const third = await storeProposal({
      attempt: 1,
      processorVersionId: versionTwoId,
      payload: {
        items: [
          { logicalKey: 'a', value: 1 },
          { logicalKey: 'b', value: 3 },
          { logicalKey: 'd', value: 1 },
        ],
      },
      timestamp: 530_000,
    });
    const thirdDefinition = { ...definition, semanticVersion: '2.0.0' };
    expect(
      (await reconcile(third, thirdDefinition)).outcomes.map(
        ({ outcome }) => outcome,
      ),
    ).toEqual(['unchanged', 'supersede', 'unchanged', 'remove_supersede']);

    const artifacts = await client.database.select().from(processorArtifacts);
    expect(artifacts).toHaveLength(4);
    expect(artifacts.filter(({ active }) => active)).toHaveLength(3);
    const versions = await client.database
      .select()
      .from(processorArtifactVersions);
    expect(versions).toHaveLength(7);
    expect(
      versions.filter(({ lifecycle }) => lifecycle === 'active'),
    ).toHaveLength(3);
  });

  it('[STATE-004] makes concurrent duplicate delivery database-idempotent', async () => {
    const proposal = await storeProposal({
      attempt: 2,
      processorVersionId: versionTwoId,
      payload: { items: [{ logicalKey: 'a', value: 4 }] },
      timestamp: 540_000,
    });
    const candidateDefinition = { ...definition, semanticVersion: '2.0.0' };
    const [left, right] = await Promise.all([
      reconcile(proposal, candidateDefinition),
      reconcile(proposal, candidateDefinition),
    ]);
    expect(left.reconciliation.inputHash).toBe(right.reconciliation.inputHash);
    expect(left.outcomes).toEqual(right.outcomes);
    expect(
      await client.database
        .select()
        .from(processorReconciliations)
        .where(eq(processorReconciliations.runId, proposal.run.id)),
    ).toHaveLength(1);
  });

  it('[PROC-005][STATE-004] serializes concurrent whole-day reconciliation and preserves one active version per stable key', async () => {
    const left = await storeProposal({
      attempt: 3,
      processorVersionId: versionTwoId,
      payload: { items: [{ logicalKey: 'shared', value: 1 }] },
      timestamp: 550_000,
    });
    const right = await storeProposal({
      attempt: 4,
      processorVersionId: versionTwoId,
      payload: { items: [{ logicalKey: 'shared', value: 2 }] },
      timestamp: 560_000,
    });
    const candidateDefinition = { ...definition, semanticVersion: '2.0.0' };
    const results = await Promise.all([
      reconcile(left, candidateDefinition),
      reconcile(right, candidateDefinition),
    ]);
    const outcomes = results.flatMap((item) =>
      item.outcomes.map(({ outcome }) => outcome),
    );
    expect(outcomes).toEqual(expect.arrayContaining(['create', 'update']));
    const [artifact] = await client.database
      .select()
      .from(processorArtifacts)
      .where(eq(processorArtifacts.logicalKey, 'string:shared'));
    if (artifact === undefined)
      throw new Error('Expected shared stable artifact.');
    expect(
      (
        await client.database
          .select()
          .from(processorArtifactVersions)
          .where(eq(processorArtifactVersions.artifactId, artifact.id))
      ).filter(({ lifecycle }) => lifecycle === 'active'),
    ).toHaveLength(1);
  });

  it('[STATE-005] retains unseen current artifacts when a day result is explicitly partial', async () => {
    const partial = await storeProposal({
      attempt: 5,
      processorVersionId: versionTwoId,
      payload: { items: [] },
      completeness: 'partial',
      timestamp: 570_000,
    });
    expect(
      (await reconcile(partial, { ...definition, semanticVersion: '2.0.0' }))
        .outcomes,
    ).toEqual([]);
    expect(
      (await client.database.select().from(processorArtifacts)).filter(
        ({ active }) => active,
      ).length,
    ).toBeGreaterThan(0);
  });

  it('[STATE-004] rejects direct duplicate reconciliation rows at the database boundary', async () => {
    const [record] = await client.database
      .select()
      .from(processorReconciliations)
      .limit(1);
    if (record === undefined)
      throw new Error('Expected reconciliation fixture.');
    await expect(
      client.database.insert(processorReconciliations).values(record),
    ).rejects.toMatchObject({ cause: { code: '23505' } });
    const outcomes = await client.database
      .select()
      .from(processorReconciliationOutcomes)
      .where(eq(processorReconciliationOutcomes.runId, record.runId));
    expect(outcomes.length).toBeGreaterThan(0);
  });
});
