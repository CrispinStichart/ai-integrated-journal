import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { AiProviderFactoryRegistry } from '@journal/ai';
import {
  appendCorrectedTranscriptRevision,
  contributions,
  createDatabaseClient,
  enqueueTranscriptCleanup,
  enqueueTranscriptionRun,
  inTransaction,
  journalDays,
  migrateDatabase,
  recordings,
  transcriptCleanupRuns,
  transcriptionRuns,
  transcriptRevisions,
  transcripts,
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
import { and, asc, eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { BlobRawResponseStore } from '../src/raw-response-store.js';
import {
  TRANSCRIPT_CLEANUP_PROMPT,
  TranscriptCleanupJobHandler,
} from '../src/transcript-cleanup-pipeline.js';
import { TranscriptionJobHandler } from '../src/transcription-pipeline.js';

function sha256(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

async function* bytes(value: Uint8Array): AsyncGenerator<Uint8Array> {
  yield value;
}

describe('TRANSCRIPT asynchronous transcription pipeline', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let blobRoot: string;
  let blobs: LocalBlobStore;
  let queuedPayload: QueueJobPayload | undefined;
  let boss: PgBoss;

  const ownerId = createUuidV7<'user'>({ timestamp: 200_000 });
  const recordingId = createUuidV7<'recording'>({ timestamp: 201_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 202_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 203_000 });
  const audio = new TextEncoder().encode('synthetic audio bytes');
  const audioKey = `audio/${recordingId}/original.audio`;
  const now = new Date('2026-08-23T01:00:00.000Z');

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    blobRoot = await mkdtemp(path.join(tmpdir(), 'journal-transcription-'));
    blobs = new LocalBlobStore(blobRoot);
    await blobs.putImmutable(bytes(audio), {
      key: audioKey,
      expectedIntegrity: {
        byteSize: BigInt(audio.byteLength),
        sha256: sha256(audio),
      },
    });
    await client.database.insert(users).values({
      id: ownerId,
      displayName: 'Synthetic transcription owner',
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
      sourceType: 'recording',
      capturedAt: now,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(recordings).values({
      id: recordingId,
      contributionId,
      mimeType: 'audio/webm;codecs=opus',
      finalByteSize: BigInt(audio.byteLength),
      finalSha256: sha256(audio),
      finalBlobKey: audioKey,
      persistenceState: 'durable',
    });
    boss = {
      send: async (
        _name: string,
        payload: object,
        options?: { id?: string },
      ) => {
        queuedPayload = payload as QueueJobPayload;
        return options?.id ?? null;
      },
    } as unknown as PgBoss;
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
    if (blobRoot !== undefined)
      await rm(blobRoot, { recursive: true, force: true });
  });

  it('[STT-001][DATA-022][DATA-023][DATA-024][DATA-025][DATA-026][ARCH-004][AC-011][MODEL-002] preserves distinct raw, corrected, and cleaned revision lineage', async () => {
    const context = [
      { text: 'Nicolette', purpose: 'approved vocabulary', version: '3' },
    ] as const;
    const configuration = { temperature: 0, timestamps: true } as const;
    const run = await inTransaction(client.database, (transaction) =>
      enqueueTranscriptionRun({
        boss,
        transaction,
        recordingId,
        requestedContext: context,
        requestedConfiguration: configuration,
        now,
      }),
    );
    expect(queuedPayload).toMatchObject({
      identifiers: { recordingId, runId: run.id },
      operation: 'transcribe_recording',
    });

    const registry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-stt',
        speech: {
          text: 'hello journal',
          language: 'en',
          timestamps: true,
        },
      }),
    ]);
    const handler = new TranscriptionJobHandler(
      client,
      boss,
      blobs,
      () =>
        registry.resolve(
          { providerId: 'fixture-stt', enabled: true, settings: {} },
          'speech_to_text',
        ),
      () => now,
    );
    if (queuedPayload === undefined) throw new Error('Expected queued work.');
    const canonical = await handler.load(queuedPayload);
    if (canonical.input === undefined)
      throw new Error('Expected runnable work.');
    await handler.execute(canonical.input, new AbortController().signal);

    const [persistedRun] = await client.database
      .select()
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.id, run.id));
    const [transcript] = await client.database
      .select()
      .from(transcripts)
      .where(
        and(
          eq(transcripts.recordingId, recordingId),
          eq(transcripts.layer, 'raw_stt'),
        ),
      );
    const [correctedTranscript] = await client.database
      .select()
      .from(transcripts)
      .where(
        and(
          eq(transcripts.recordingId, recordingId),
          eq(transcripts.layer, 'corrected'),
        ),
      );
    const [revision] = await client.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.sourceRunId, run.id));

    expect(persistedRun).toMatchObject({
      status: 'succeeded',
      attempt: 1,
      inputAudioSha256: sha256(audio),
      requestedContext: context,
      effectiveContext: context,
      requestedConfiguration: configuration,
      provider: { id: 'fixture-stt', adapterVersion: 'fake-v1' },
      model: { id: 'deterministic-speech-v1', version: '1' },
      language: { status: 'known', value: 'en' },
      timingAvailability: { segments: 'known', words: 'known' },
      rawResponseRetention: 'days_30',
    });
    expect(transcript).toMatchObject({
      recordingId,
      layer: 'raw_stt',
      currentRevision: 1,
    });
    expect(revision).toMatchObject({
      sourceRunId: run.id,
      revision: 1,
      text: 'hello journal',
      authority: 'generated',
      language: { status: 'known', value: 'en' },
      timingAvailability: { segments: 'known', words: 'known' },
    });
    expect(revision?.segments[0]).toMatchObject({
      text: 'hello journal',
      timing: { status: 'known', startMs: 0, endMs: 500 },
    });
    if (persistedRun?.rawResponseId === null || persistedRun === undefined) {
      throw new Error('Expected retained raw response.');
    }
    const exact = await new BlobRawResponseStore(client.database, blobs).open(
      persistedRun.rawResponseId,
    );
    expect(new TextDecoder().decode(exact.body)).toBe(
      `{"byte_length":${String(audio.byteLength)},"language":"en","text":"hello journal","timestamps":true}`,
    );

    expect(correctedTranscript).toMatchObject({
      recordingId,
      layer: 'corrected',
      currentRevision: 1,
    });
    const [initialCorrection] = await client.database
      .select()
      .from(transcriptRevisions)
      .where(
        eq(
          transcriptRevisions.id,
          correctedTranscript?.currentRevisionId ?? '',
        ),
      );
    expect(initialCorrection).toMatchObject({
      sourceRunId: null,
      sourceRevisionId: revision?.id,
      text: 'hello journal',
      authority: 'generated',
      authorId: null,
    });
    expect(queuedPayload).toMatchObject({
      operation: 'clean_transcript',
      identifiers: { sourceRevisionId: initialCorrection?.id },
    });

    const cleanupRegistry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-cleanup',
        structuredOutput: { cleanedText: 'Hello, journal.' },
      }),
    ]);
    const cleanupHandler = new TranscriptCleanupJobHandler(
      client,
      blobs,
      () =>
        cleanupRegistry.resolve(
          { providerId: 'fixture-cleanup', enabled: true, settings: {} },
          'structured_generation',
        ),
      () => now,
    );
    if (queuedPayload === undefined) throw new Error('Expected cleanup work.');
    const cleanupCanonical = await cleanupHandler.load(queuedPayload);
    if (cleanupCanonical.input === undefined) {
      throw new Error('Expected runnable cleanup work.');
    }
    await cleanupHandler.execute(
      cleanupCanonical.input,
      new AbortController().signal,
    );

    const [cleanedTranscript] = await client.database
      .select()
      .from(transcripts)
      .where(
        and(
          eq(transcripts.recordingId, recordingId),
          eq(transcripts.layer, 'cleaned'),
        ),
      );
    const [firstCleanedRevision] = await client.database
      .select()
      .from(transcriptRevisions)
      .where(
        eq(transcriptRevisions.id, cleanedTranscript?.currentRevisionId ?? ''),
      );
    expect(firstCleanedRevision).toMatchObject({
      sourceRunId: null,
      sourceRevisionId: initialCorrection?.id,
      text: 'Hello, journal.',
      authority: 'generated',
    });

    if (correctedTranscript === undefined || initialCorrection === undefined) {
      throw new Error('Expected initialized corrected transcript.');
    }
    const correction = await appendCorrectedTranscriptRevision({
      boss,
      database: client.database,
      transcriptId: correctedTranscript.id,
      expectedRevisionId: initialCorrection.id,
      authorId: ownerId,
      text: 'Hello Nicolette.',
      editReason: 'Corrected the name.',
      prompt: TRANSCRIPT_CLEANUP_PROMPT,
      now,
    });
    expect(correction.revision).toMatchObject({
      revision: 2,
      sourceRevisionId: initialCorrection.id,
      text: 'Hello Nicolette.',
      authority: 'manual',
      authorId: ownerId,
      editReason: 'Corrected the name.',
    });
    expect(queuedPayload).toMatchObject({
      operation: 'clean_transcript',
      identifiers: { sourceRevisionId: correction.revision.id },
    });

    const correctedCleanupRegistry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-cleanup',
        structuredOutput: { cleanedText: 'Hello Nicolette.' },
      }),
    ]);
    const correctedCleanupHandler = new TranscriptCleanupJobHandler(
      client,
      blobs,
      () =>
        correctedCleanupRegistry.resolve(
          { providerId: 'fixture-cleanup', enabled: true, settings: {} },
          'structured_generation',
        ),
      () => now,
    );
    if (queuedPayload === undefined) {
      throw new Error('Expected corrected cleanup work.');
    }
    const correctedCleanupCanonical =
      await correctedCleanupHandler.load(queuedPayload);
    if (correctedCleanupCanonical.input === undefined) {
      throw new Error('Expected runnable corrected cleanup work.');
    }
    await correctedCleanupHandler.execute(
      correctedCleanupCanonical.input,
      new AbortController().signal,
    );

    const rawHistory = await client.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, transcript?.id ?? ''));
    const correctionHistory = await client.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, correctedTranscript.id))
      .orderBy(asc(transcriptRevisions.revision));
    const cleanedHistory = await client.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.transcriptId, cleanedTranscript?.id ?? ''))
      .orderBy(asc(transcriptRevisions.revision));
    expect(rawHistory).toHaveLength(1);
    expect(rawHistory[0]?.text).toBe('hello journal');
    expect(correctionHistory.map(({ text }) => text)).toEqual([
      'hello journal',
      'Hello Nicolette.',
    ]);
    expect(cleanedHistory).toMatchObject([
      { sourceRevisionId: initialCorrection.id, text: 'Hello, journal.' },
      {
        sourceRevisionId: correction.revision.id,
        text: 'Hello Nicolette.',
      },
    ]);
    const cleanupRuns = await client.database
      .select()
      .from(transcriptCleanupRuns)
      .where(eq(transcriptCleanupRuns.recordingId, recordingId));
    expect(cleanupRuns).toHaveLength(2);
    expect(cleanupRuns.every(({ status }) => status === 'succeeded')).toBe(
      true,
    );
    await expect(
      appendCorrectedTranscriptRevision({
        boss,
        database: client.database,
        transcriptId: correctedTranscript.id,
        expectedRevisionId: initialCorrection.id,
        authorId: ownerId,
        text: 'Conflicting edit',
        prompt: TRANSCRIPT_CLEANUP_PROMPT,
        now,
      }),
    ).rejects.toMatchObject({
      name: 'TranscriptRevisionConflictError',
      actualRevisionId: correction.revision.id,
    });
    const rejectingBoss = {
      send: async () => null,
    } as unknown as PgBoss;
    await expect(
      appendCorrectedTranscriptRevision({
        boss: rejectingBoss,
        database: client.database,
        transcriptId: correctedTranscript.id,
        expectedRevisionId: correction.revision.id,
        authorId: ownerId,
        text: 'This transaction must roll back.',
        prompt: TRANSCRIPT_CLEANUP_PROMPT,
        now,
      }),
    ).rejects.toMatchObject({ name: 'QueueFoundationError' });
    const [afterRejectedQueue] = await client.database
      .select()
      .from(transcripts)
      .where(eq(transcripts.id, correctedTranscript.id));
    expect(afterRejectedQueue).toMatchObject({
      currentRevisionId: correction.revision.id,
      currentRevision: 2,
    });
  });

  it('[STT-002][ARCH-005][DATA-025][DATA-028][MODEL-003] isolates STT and cleanup failures and retries each stage', async () => {
    const failedRecordingId = createUuidV7<'recording'>({ timestamp: 204_000 });
    const failedContributionId = createUuidV7<'contribution'>({
      timestamp: 205_000,
    });
    const failedAudioKey = `audio/${failedRecordingId}/original.audio`;
    await blobs.putImmutable(bytes(audio), {
      key: failedAudioKey,
      expectedIntegrity: {
        byteSize: BigInt(audio.byteLength),
        sha256: sha256(audio),
      },
    });
    await client.database.insert(contributions).values({
      id: failedContributionId,
      journalDayId: dayId,
      authorId: ownerId,
      sourceType: 'recording',
      capturedAt: now,
      capturedTimezone: 'UTC',
      journalTimezone: 'UTC',
      journalDateAssignment: 'default',
    });
    await client.database.insert(recordings).values({
      id: failedRecordingId,
      contributionId: failedContributionId,
      mimeType: 'audio/webm',
      finalByteSize: BigInt(audio.byteLength),
      finalSha256: sha256(audio),
      finalBlobKey: failedAudioKey,
      persistenceState: 'durable',
    });
    const first = await inTransaction(client.database, (transaction) =>
      enqueueTranscriptionRun({
        boss,
        transaction,
        recordingId: failedRecordingId,
        now,
      }),
    );
    if (queuedPayload === undefined) throw new Error('Expected queued work.');
    const unavailable = new TranscriptionJobHandler(
      client,
      boss,
      blobs,
      async () => ({
        status: 'unavailable',
        providerId: 'missing',
        capability: 'speech_to_text',
        reason: 'provider_not_registered',
      }),
      () => now,
    );
    const canonical = await unavailable.load(queuedPayload);
    if (canonical.input === undefined)
      throw new Error('Expected runnable work.');
    await expect(
      unavailable.execute(canonical.input, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'permanent' });

    const [failed] = await client.database
      .select()
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.id, first.id));
    const original = await blobs.stat(failedAudioKey);
    expect(failed).toMatchObject({
      status: 'failed',
      errorCode: 'provider_not_registered',
      errorRetryable: false,
    });
    expect(original.sha256).toBe(sha256(audio));

    const retry = await inTransaction(client.database, (transaction) =>
      enqueueTranscriptionRun({
        boss,
        transaction,
        recordingId: failedRecordingId,
        retryTerminal: true,
        now,
      }),
    );
    expect(retry).toMatchObject({
      recordingId: failedRecordingId,
      predecessorRunId: first.id,
      attempt: 2,
      status: 'queued',
    });

    const retryRegistry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-untimed',
        speech: { text: 'recovered transcript', timestamps: false },
      }),
    ]);
    const retryHandler = new TranscriptionJobHandler(
      client,
      boss,
      blobs,
      () =>
        retryRegistry.resolve(
          { providerId: 'fixture-untimed', enabled: true, settings: {} },
          'speech_to_text',
        ),
      () => now,
    );
    if (queuedPayload === undefined) throw new Error('Expected retry work.');
    const retryCanonical = await retryHandler.load(queuedPayload);
    if (retryCanonical.input === undefined)
      throw new Error('Expected runnable retry.');
    await retryHandler.execute(
      retryCanonical.input,
      new AbortController().signal,
    );

    const [completedRetry] = await client.database
      .select()
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.id, retry.id));
    const [untimedRevision] = await client.database
      .select()
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.sourceRunId, retry.id));
    const [preservedFailure] = await client.database
      .select()
      .from(transcriptionRuns)
      .where(eq(transcriptionRuns.id, first.id));
    expect(completedRetry).toMatchObject({
      status: 'succeeded',
      attempt: 2,
      language: { status: 'unknown' },
      timingAvailability: { segments: 'unknown', words: 'unknown' },
    });
    expect(untimedRevision).toMatchObject({
      text: 'recovered transcript',
      timingAvailability: { segments: 'unknown', words: 'unknown' },
      segments: [
        {
          timing: { status: 'unknown' },
          words: { status: 'unknown' },
        },
      ],
    });
    expect(preservedFailure).toMatchObject({
      status: 'failed',
      errorCode: 'provider_not_registered',
    });

    if (queuedPayload === undefined) throw new Error('Expected cleanup work.');
    const unavailableCleanup = new TranscriptCleanupJobHandler(
      client,
      blobs,
      async () => ({
        status: 'unavailable',
        providerId: 'missing',
        capability: 'structured_generation',
        reason: 'provider_not_registered',
      }),
      () => now,
    );
    const cleanupCanonical = await unavailableCleanup.load(queuedPayload);
    if (cleanupCanonical.input === undefined) {
      throw new Error('Expected runnable cleanup work.');
    }
    const cleanupInput = cleanupCanonical.input;
    await expect(
      unavailableCleanup.execute(cleanupInput, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'permanent' });

    const [failedCleanup] = await client.database
      .select()
      .from(transcriptCleanupRuns)
      .where(
        eq(
          transcriptCleanupRuns.sourceCorrectedRevisionId,
          cleanupInput.sourceRevision.id,
        ),
      );
    expect(failedCleanup).toMatchObject({
      status: 'failed',
      errorCode: 'provider_not_registered',
      outputCleanedRevisionId: null,
    });
    const retryCleanup = await inTransaction(client.database, (transaction) =>
      enqueueTranscriptCleanup({
        boss,
        transaction,
        sourceCorrectedRevisionId: cleanupInput.sourceRevision.id,
        prompt: TRANSCRIPT_CLEANUP_PROMPT,
        retryTerminal: true,
        now,
      }),
    );
    expect(retryCleanup).toMatchObject({
      predecessorRunId: failedCleanup?.id,
      attempt: 2,
      status: 'queued',
    });

    const recoveredCleanupRegistry = new AiProviderFactoryRegistry([
      createDeterministicAiProviderFactory({
        providerId: 'fixture-cleanup-retry',
        structuredOutput: { cleanedText: 'Recovered transcript.' },
      }),
    ]);
    const recoveredCleanup = new TranscriptCleanupJobHandler(
      client,
      blobs,
      () =>
        recoveredCleanupRegistry.resolve(
          {
            providerId: 'fixture-cleanup-retry',
            enabled: true,
            settings: {},
          },
          'structured_generation',
        ),
      () => now,
    );
    if (queuedPayload === undefined) {
      throw new Error('Expected retried cleanup work.');
    }
    const recoveredCanonical = await recoveredCleanup.load(queuedPayload);
    if (recoveredCanonical.input === undefined) {
      throw new Error('Expected runnable retried cleanup work.');
    }
    await recoveredCleanup.execute(
      recoveredCanonical.input,
      new AbortController().signal,
    );
    const [completedCleanup] = await client.database
      .select()
      .from(transcriptCleanupRuns)
      .where(eq(transcriptCleanupRuns.id, retryCleanup.id));
    expect(completedCleanup).toMatchObject({
      status: 'succeeded',
      predecessorRunId: failedCleanup?.id,
    });
  });
});
