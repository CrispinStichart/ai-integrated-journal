import { createHash } from 'node:crypto';

import {
  contributions,
  createDatabaseClient,
  journalDays,
  migrateDatabase,
  recordings,
  transcriptCleanupRuns,
  transcriptRevisions,
  transcriptSegments,
  transcriptionRuns,
  transcripts,
  users,
  type DatabaseClient,
} from '@journal/database';
import { createUuidV7 } from '@journal/domain';
import { createPostgresTestContainer } from '@journal/test-support';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  PostgresTranscriptService,
  TranscriptNotFoundError,
} from '../src/transcript-service.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('transcript inspector persistence', () => {
  type TestContainer = ReturnType<typeof createPostgresTestContainer>;
  let container: Awaited<ReturnType<TestContainer['start']>>;
  let client: DatabaseClient;
  let service: PostgresTranscriptService;

  const ownerId = createUuidV7<'user'>({ timestamp: 300_000 });
  const otherOwnerId = createUuidV7<'user'>({ timestamp: 301_000 });
  const dayId = createUuidV7<'journal-day'>({ timestamp: 302_000 });
  const contributionId = createUuidV7<'contribution'>({ timestamp: 303_000 });
  const recordingId = createUuidV7<'recording'>({ timestamp: 304_000 });
  const transcriptionRunId = createUuidV7<'transcription-run'>({
    timestamp: 305_000,
  });
  const rawTranscriptId = createUuidV7<'transcript'>({ timestamp: 306_000 });
  const rawRevisionId = createUuidV7<'transcript-revision'>({
    timestamp: 307_000,
  });
  const rawSegmentId = createUuidV7<'transcript-segment'>({
    timestamp: 308_000,
  });
  const correctedTranscriptId = createUuidV7<'transcript'>({
    timestamp: 309_000,
  });
  const correctedRevisionId = createUuidV7<'transcript-revision'>({
    timestamp: 310_000,
  });
  const correctedSegmentId = createUuidV7<'transcript-segment'>({
    timestamp: 311_000,
  });
  const cleanedTranscriptId = createUuidV7<'transcript'>({
    timestamp: 312_000,
  });
  const cleanedRevisionId = createUuidV7<'transcript-revision'>({
    timestamp: 313_000,
  });
  const cleanupRunId = createUuidV7<'cleanup-run'>({ timestamp: 314_000 });
  const correlationId = createUuidV7<'correlation'>({ timestamp: 315_000 });
  const now = new Date('2026-08-23T12:00:00.000Z');
  const rawText = 'Raw provider words';

  beforeAll(async () => {
    container = await createPostgresTestContainer().start();
    client = createDatabaseClient({
      connectionString: container.getConnectionUri(),
      pool: { max: 4 },
    });
    await migrateDatabase(client.database);
    await client.database
      .insert(users)
      .values({ id: ownerId, displayName: 'Transcript owner' });
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
      persistenceState: 'durable',
      finalByteSize: 100n,
      finalSha256: sha256('audio'),
      finalBlobKey: `audio/${recordingId}/original.audio`,
    });
    await client.database.insert(transcriptionRuns).values({
      id: transcriptionRunId,
      recordingId,
      attempt: 1,
      status: 'succeeded',
      inputAudioSha256: sha256('audio'),
      inputFingerprint: sha256('transcription-input'),
      provider: { id: 'fake-stt' },
      model: { id: 'fake-model' },
      language: { code: 'en' },
      timingAvailability: { segments: 'known' },
      processingTimeMilliseconds: 50n,
      completedAt: now,
      queuedAt: now,
      updatedAt: now,
    });
    await client.database
      .update(recordings)
      .set({
        transcriptionState: 'succeeded',
        latestTranscriptionRunId: transcriptionRunId,
      })
      .where(eq(recordings.id, recordingId));

    await client.database.insert(transcripts).values([
      { id: rawTranscriptId, recordingId, layer: 'raw_stt' },
      { id: correctedTranscriptId, recordingId, layer: 'corrected' },
      { id: cleanedTranscriptId, recordingId, layer: 'cleaned' },
    ]);
    await client.database.insert(transcriptRevisions).values({
      id: rawRevisionId,
      transcriptId: rawTranscriptId,
      sourceRunId: transcriptionRunId,
      revision: 1,
      text: rawText,
      evidenceText: rawText,
      segments: [],
      language: { code: 'en' },
      timingAvailability: { segments: 'known' },
      authority: 'generated',
      contentHash: sha256(rawText),
      createdAt: now,
    });
    await client.database.insert(transcriptRevisions).values({
      id: correctedRevisionId,
      transcriptId: correctedTranscriptId,
      sourceRevisionId: rawRevisionId,
      revision: 1,
      text: rawText,
      evidenceText: rawText,
      segments: [],
      language: { code: 'en' },
      timingAvailability: { segments: 'known' },
      authority: 'generated',
      contentHash: sha256(rawText),
      createdAt: now,
    });
    await client.database.insert(transcriptRevisions).values({
      id: cleanedRevisionId,
      transcriptId: cleanedTranscriptId,
      sourceRevisionId: correctedRevisionId,
      revision: 1,
      text: 'Provider words',
      evidenceText: 'Provider words',
      segments: [],
      language: { code: 'en' },
      timingAvailability: { segments: 'unknown' },
      authority: 'generated',
      contentHash: sha256('Provider words'),
      createdAt: now,
    });
    await client.database.insert(transcriptSegments).values([
      {
        id: rawSegmentId,
        transcriptRevisionId: rawRevisionId,
        ordinal: 0,
        startUtf16: 0,
        endUtf16: rawText.length,
        startMs: 1200n,
        endMs: 2600n,
        quote: rawText,
        quoteHash: sha256(rawText),
        createdAt: now,
      },
      {
        id: correctedSegmentId,
        transcriptRevisionId: correctedRevisionId,
        sourceSegmentId: rawSegmentId,
        ordinal: 0,
        startUtf16: 0,
        endUtf16: rawText.length,
        startMs: 1200n,
        endMs: 2600n,
        quote: rawText,
        quoteHash: sha256(rawText),
        createdAt: now,
      },
    ]);
    await client.database
      .update(transcripts)
      .set({ currentRevisionId: rawRevisionId, currentRevision: 1 })
      .where(eq(transcripts.id, rawTranscriptId));
    await client.database
      .update(transcripts)
      .set({ currentRevisionId: correctedRevisionId, currentRevision: 1 })
      .where(eq(transcripts.id, correctedTranscriptId));
    await client.database
      .update(transcripts)
      .set({ currentRevisionId: cleanedRevisionId, currentRevision: 1 })
      .where(eq(transcripts.id, cleanedTranscriptId));
    await client.database.insert(transcriptCleanupRuns).values({
      id: cleanupRunId,
      recordingId,
      sourceCorrectedRevisionId: correctedRevisionId,
      outputCleanedRevisionId: cleanedRevisionId,
      attempt: 1,
      status: 'succeeded',
      inputFingerprint: sha256('cleanup-input'),
      promptId: 'builtin.transcript-cleanup',
      promptVersion: '1',
      promptTemplateHash: sha256('cleanup-prompt'),
      requestedConfiguration: { temperature: 0 },
      completedAt: now,
      queuedAt: now,
      updatedAt: now,
    });
    const boss = {
      send: async (
        _name: string,
        _payload: object,
        options?: { id?: string },
      ) => options?.id ?? null,
    } as unknown as PgBoss;
    service = new PostgresTranscriptService(client.database, boss, () => now);
  }, 120_000);

  afterAll(async () => {
    await client?.close();
    await container?.stop();
  });

  it('[AC-010][AC-012][DATA-022][DATA-024][DATA-025][DATA-027][SEC-001] reads distinct owned layers and exact timed evidence', async () => {
    const result = await service.inspect(ownerId, recordingId);
    expect(result).toMatchObject({
      audioAvailable: true,
      rawStt: {
        layer: 'raw_stt',
        currentRevision: {
          text: rawText,
          segments: [
            {
              id: rawSegmentId,
              quote: rawText,
              timing: {
                status: 'known',
                startMilliseconds: '1200',
                endMilliseconds: '2600',
              },
            },
          ],
        },
      },
      corrected: { layer: 'corrected' },
      cleaned: { layer: 'cleaned' },
    });
    await expect(
      service.inspect(otherOwnerId, recordingId),
    ).rejects.toBeInstanceOf(TranscriptNotFoundError);
  });

  it('[AC-011][DATA-026][EDIT-001][ARCH-004][MEM-002][STATE-004] appends a manual correction, stales only dependents, queues cleanup, and replays idempotently', async () => {
    const first = await service.editCorrected(
      ownerId,
      correctedTranscriptId,
      1,
      'Human corrected words',
      'Corrected a name',
      'transcript-edit-1',
      correlationId,
    );
    expect(first.replayed).toBe(false);
    expect(first.inspector).toMatchObject({
      rawStt: { currentRevision: { text: rawText, revision: 1 } },
      corrected: {
        currentRevision: {
          text: 'Human corrected words',
          revision: 2,
          authority: 'manual',
        },
      },
      cleaned: {
        currentRevision: {
          text: 'Provider words',
          staleReason: 'source_revision_superseded',
        },
      },
      cleanup: { status: 'queued', sourceRevisionId: expect.any(String) },
    });
    const replay = await service.editCorrected(
      ownerId,
      correctedTranscriptId,
      1,
      'Human corrected words',
      'Corrected a name',
      'transcript-edit-1',
      correlationId,
    );
    expect(replay.replayed).toBe(true);
    expect(await service.history(ownerId, correctedTranscriptId)).toHaveLength(
      2,
    );
  });
});
