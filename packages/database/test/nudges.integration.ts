import { createHash } from 'node:crypto';

import type { ProcessorDefinitionDraft } from '@journal/contracts';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  NudgeRepository,
  contributionRevisions,
  contributions,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  nudgeActions,
  nudgeDigests,
  nudgeItems,
  processorInstallations,
  processorResults,
  processorRuns,
  processorVersions,
  requirementEvaluations,
  users,
  type DatabaseClient,
} from '../src/index.js';

function sha(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

describe('requirement and nudge persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  const ownerId = createUuidV7<'user'>({ timestamp: 800_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 801_000 });
  const now = new Date('2026-08-23T20:00:00.000Z');
  let idTimestamp = 900_000;
  const id = () => createUuidV7<'nudge'>({ timestamp: idTimestamp++ });

  const definition: ProcessorDefinitionDraft = {
    semanticVersion: '1.0.0',
    kind: 'observation_extractor',
    instructions: 'Evaluate only synthetic source-grounded information.',
    input: { scope: 'journal_day', selectors: ['typed_text'] },
    dependencies: [],
    outputSchemaVersion: '1.0.0',
    outputSchema: {
      type: 'object',
      required: ['items'],
      properties: { items: { type: 'array', items: { type: 'string' } } },
      additionalProperties: false,
    },
    reconciliation: { strategy: 'replace_scope' },
    requirementMode: 'required',
    defaultEnabled: true,
    nudgePolicy: {
      enabled: true,
      prompt: 'Add synthetic required information.',
      allowNotApplicable: true,
    },
    capabilityRequirements: ['structured_generation'],
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
      pool: { max: 6 },
    });
    await migrateDatabase(client.database);
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Synthetic nudge owner',
      journalTimeZone: 'Etc/UTC',
    });
    await client.database.insert(journalDays).values({
      id: dayId,
      userId: ownerId,
      journalDate: '2026-08-23',
    });
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  async function createRun(
    key: string,
    outcome: 'insufficient' | 'failed' | 'satisfied',
    targetDayId = dayId,
  ) {
    const processorId = id();
    const versionId = id();
    const runId = id();
    const resultId = id();
    await client.database.insert(processorInstallations).values({
      id: processorId,
      key,
      displayName: `Synthetic ${key}`,
      purpose: 'Synthetic requirement fixture',
      enabled: true,
      requirementMode: 'required',
      builtIn: false,
      currentVersionId: versionId,
    });
    await client.database.insert(processorVersions).values({
      id: versionId,
      processorId,
      revision: 1,
      semanticVersion: '1.0.0',
      definition,
      instructionHash: sha(definition.instructions),
      outputSchemaHash: sha(definition.outputSchema),
      promptTemplateHash: sha({ key }),
      createdBy: ownerId,
    });
    await client.database.insert(processorRuns).values({
      id: runId,
      processorId,
      processorVersionId: versionId,
      targetScope: 'journal_day',
      targetJournalDayId: targetDayId,
      attempt: 1,
      status: outcome === 'failed' ? 'failed' : 'succeeded',
      inputCompleteness: 'complete',
      inputFingerprint: sha({ key, input: true }),
      promptAssemblyVersion: 'synthetic-v1',
      promptTemplateHash: sha({ key }),
      ...(outcome === 'failed'
        ? { errorCode: 'synthetic_failure', errorRetryable: false }
        : { outputResultId: resultId }),
      queuedAt: now,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    });
    if (outcome !== 'failed')
      await client.database.insert(processorResults).values({
        id: resultId,
        runId,
        processorId,
        processorVersionId: versionId,
        targetJournalDayId: targetDayId,
        kind: 'observation',
        lifecycle: 'active',
        completeness: 'complete',
        payload: {
          items: outcome === 'satisfied' ? ['known synthetic value'] : [],
        },
        authority: 'generated',
        manuallyModified: false,
        createdAt: now,
        updatedAt: now,
      });
    return { processorId, versionId, runId };
  }

  it('[NUDGE-002][NUDGE-004][NUDGE-005][NUDGE-007][AC-042][AC-043] consolidates three successful insufficiencies once and excludes technical failure', async () => {
    const repository = new NudgeRepository(client.database, id);
    const missing = await Promise.all([
      createRun('required-one', 'insufficient'),
      createRun('required-two', 'insufficient'),
      createRun('required-three', 'insufficient'),
    ]);
    const failed = await createRun('required-failed', 'failed');
    const satisfied = await createRun('required-satisfied', 'satisfied');
    for (const run of [...missing, failed, satisfied])
      await repository.recordProcessorRun(run.runId, now);

    const [left, right] = await Promise.all([
      repository.runSchedule(now),
      repository.runSchedule(now),
    ]);
    expect([...left.createdDigestIds, ...right.createdDigestIds]).toHaveLength(
      1,
    );
    const digests = await client.database.select().from(nudgeDigests);
    const items = await client.database.select().from(nudgeItems);
    const evaluations = await client.database
      .select()
      .from(requirementEvaluations);
    expect(digests).toHaveLength(1);
    expect(digests[0]).toMatchObject({ status: 'published', revision: 1 });
    expect(items).toHaveLength(3);
    expect(
      evaluations.find(
        (evaluation) => evaluation.processorId === failed.processorId,
      )?.state,
    ).toBe('failed');
    expect(
      evaluations.find(
        (evaluation) => evaluation.processorId === satisfied.processorId,
      )?.state,
    ).toBe('satisfied');
    expect(
      evaluations.filter(
        (evaluation) => evaluation.state === 'pending_user_response',
      ),
    ).toHaveLength(3);
  });

  it('[DATA-013][NUDGE-005][NUDGE-006][AC-042] persists linked dismissal response and prevents repeated default prompting for the day', async () => {
    const repository = new NudgeRepository(client.database, id);
    const [digest] = await client.database.select().from(nudgeDigests).limit(1);
    if (digest === undefined) throw new Error('Digest fixture missing.');
    const contributionId = id();
    const revisionId = id();
    const result = await repository.act({
      ownerId,
      digestId: digest.id,
      expectedRevision: digest.revision,
      request: {
        action: 'dismiss',
        contributionId,
        revisionId,
        capturedAt: now.toISOString(),
        capturedTimezone: 'Etc/UTC',
      },
      idempotencyKey: 'dismiss-synthetic-digest',
      correlationId: id(),
      now,
    });
    expect(result.replayed).toBe(false);
    const replay = await repository.act({
      ownerId,
      digestId: digest.id,
      expectedRevision: digest.revision,
      request: {
        action: 'dismiss',
        contributionId,
        revisionId,
        capturedAt: now.toISOString(),
        capturedTimezone: 'Etc/UTC',
      },
      idempotencyKey: 'dismiss-synthetic-digest',
      correlationId: id(),
      now,
    });
    expect(replay.replayed).toBe(true);
    expect(
      await repository.runSchedule(new Date(now.getTime() + 2 * 60 * 60_000)),
    ).toMatchObject({
      createdDigestIds: [],
    });
    const [savedContribution] = await client.database
      .select()
      .from(contributions)
      .where(eq(contributions.id, contributionId));
    const [savedRevision] = await client.database
      .select()
      .from(contributionRevisions)
      .where(eq(contributionRevisions.id, revisionId));
    const [action] = await client.database
      .select()
      .from(nudgeActions)
      .where(
        and(
          eq(nudgeActions.digestId, digest.id),
          eq(nudgeActions.action, 'dismiss'),
        ),
      );
    expect(savedContribution).toMatchObject({
      sourceType: 'nudge_response',
      elicitingNudgeId: digest.id,
    });
    expect(savedRevision?.text).toContain(
      'Dismissed required-information prompts',
    );
    expect(action?.responseContributionId).toBe(contributionId);
    expect(
      (
        await client.database
          .select()
          .from(requirementEvaluations)
          .where(eq(requirementEvaluations.journalDayId, dayId))
      ).filter((evaluation) => evaluation.state === 'dismissed'),
    ).toHaveLength(3);
  });

  it('[DATA-013][NUDGE-005][NUDGE-006][TIME-001] persists defer, answer, and not-applicable contributions while enforcing quiet hours', async () => {
    const secondDayId = createUuidV7<'journal-day'>({
      timestamp: idTimestamp++,
    });
    await client.database.insert(journalDays).values({
      id: secondDayId,
      userId: ownerId,
      journalDate: '2026-08-24',
    });
    const repository = new NudgeRepository(client.database, id);
    const secondNow = new Date('2026-08-24T20:00:00.000Z');
    const runs = await Promise.all([
      createRun('action-answer', 'insufficient', secondDayId),
      createRun('action-not-applicable', 'insufficient', secondDayId),
    ]);
    for (const run of runs)
      await repository.recordProcessorRun(run.runId, secondNow);
    await repository.runSchedule(secondNow);
    const [digest] = await client.database
      .select()
      .from(nudgeDigests)
      .where(eq(nudgeDigests.journalDayId, secondDayId));
    if (digest === undefined) throw new Error('Second digest fixture missing.');
    const items = await client.database
      .select()
      .from(nudgeItems)
      .where(eq(nudgeItems.digestId, digest.id));
    const answerItem = items[0];
    const notApplicableItem = items[1];
    if (answerItem === undefined || notApplicableItem === undefined)
      throw new Error('Second digest items missing.');
    const deferContributionId = id();
    await repository.act({
      ownerId,
      digestId: digest.id,
      expectedRevision: 1,
      request: {
        action: 'defer',
        deferredUntil: '2026-08-24T21:00:00.000Z',
        contributionId: deferContributionId,
        revisionId: id(),
        capturedAt: secondNow.toISOString(),
        capturedTimezone: 'Etc/UTC',
      },
      idempotencyKey: 'defer-synthetic-digest',
      correlationId: id(),
      now: secondNow,
    });
    const [deferred] = await client.database
      .select()
      .from(nudgeDigests)
      .where(eq(nudgeDigests.id, digest.id));
    expect(deferred).toMatchObject({ status: 'deferred', revision: 2 });
    expect(deferred?.scheduledAt.toISOString()).toBe(
      '2026-08-25T08:00:00.000Z',
    );

    await repository.act({
      ownerId,
      digestId: digest.id,
      expectedRevision: 2,
      request: {
        action: 'answer',
        itemId: answerItem.id,
        text: 'Synthetic direct answer.',
        contributionId: id(),
        revisionId: id(),
        capturedAt: secondNow.toISOString(),
        capturedTimezone: 'Etc/UTC',
      },
      idempotencyKey: 'answer-synthetic-digest',
      correlationId: id(),
      now: secondNow,
    });
    await repository.act({
      ownerId,
      digestId: digest.id,
      expectedRevision: 3,
      request: {
        action: 'not_applicable',
        itemId: notApplicableItem.id,
        contributionId: id(),
        revisionId: id(),
        capturedAt: secondNow.toISOString(),
        capturedTimezone: 'Etc/UTC',
      },
      idempotencyKey: 'not-applicable-synthetic-digest',
      correlationId: id(),
      now: secondNow,
    });
    const [resolved] = await client.database
      .select()
      .from(nudgeDigests)
      .where(eq(nudgeDigests.id, digest.id));
    expect(resolved).toMatchObject({ status: 'resolved', revision: 4 });
    const actionRows = await client.database
      .select()
      .from(nudgeActions)
      .where(eq(nudgeActions.digestId, digest.id));
    expect(actionRows.map((action) => action.action)).toEqual([
      'defer',
      'answer',
      'not_applicable',
    ]);
    expect(
      actionRows.every((action) => action.responseContributionId !== null),
    ).toBe(true);
  });
});
