import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

import type { BlobStore } from '@journal/storage';
import type { DatabaseClient } from '@journal/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const EXPORT_ID = '019d2b3c-4000-7000-8000-000000000002';
const OWNER_ID = '019d2b3c-4000-7000-8000-000000000001';
const repository = {
  claim: vi.fn(),
  assertRunnable: vi.fn(),
  entityTypes: vi.fn(),
  jsonLineItems: vi.fn(),
  journalDates: vi.fn(),
  markdownItems: vi.fn(),
  blobLeases: vi.fn(),
  complete: vi.fn(),
  fail: vi.fn(),
};

function zipEntries(archive: Buffer): ReadonlyMap<string, Buffer> {
  const centralSignature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const zip64EndSignature = Buffer.from([0x50, 0x4b, 0x06, 0x06]);
  const endSignature = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
  const endOffset = archive.lastIndexOf(endSignature);
  if (endOffset < 0) throw new Error('ZIP end record is missing.');
  const legacyCentralOffset = archive.readUInt32LE(endOffset + 16);
  const zip64EndOffset = archive.lastIndexOf(zip64EndSignature, endOffset);
  if (legacyCentralOffset === 0xff_ff_ff_ff && zip64EndOffset < 0)
    throw new Error('ZIP64 end record is missing.');
  const centralOffset =
    legacyCentralOffset === 0xff_ff_ff_ff
      ? Number(archive.readBigUInt64LE(zip64EndOffset + 48))
      : legacyCentralOffset;
  const entries = new Map<string, Buffer>();
  for (
    let offset = centralOffset;
    archive.subarray(offset, offset + 4).equals(centralSignature);
  ) {
    const compression = archive.readUInt16LE(offset + 10);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    const name = archive
      .subarray(offset + 46, offset + 46 + nameLength)
      .toString('utf8');
    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataOffset = localOffset + 30 + localNameLength + localExtraLength;
    const compressed = archive.subarray(
      dataOffset,
      dataOffset + compressedSize,
    );
    entries.set(
      name,
      compression === 0 ? compressed : inflateRawSync(compressed),
    );
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

vi.mock('@journal/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@journal/database')>()),
  ExportRepository: function ExportRepository() {
    return repository;
  },
}));

import { createQueueJobPayload, queueNames } from '@journal/database';
import {
  ExportJobHandler,
  serializeSnapshotDatabaseItem,
  serializeSnapshotItem,
} from '../src/export.js';

describe('streamed portable export worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.claim.mockResolvedValue({
      id: EXPORT_ID,
      ownerId: OWNER_ID,
      status: 'running',
      manifestSchemaVersion: 1,
      includeAudio: false,
      includeProviderRawResponses: false,
      snapshotAt: new Date('2026-08-25T00:00:00.000Z'),
      createdAt: new Date('2026-08-25T00:00:00.000Z'),
      expiresAt: new Date('2026-08-26T00:00:00.000Z'),
    });
    repository.assertRunnable.mockResolvedValue({ status: 'running' });
    repository.entityTypes.mockResolvedValue([
      { entityType: 'contribution_revision', count: 1 },
    ]);
    repository.jsonLineItems.mockImplementation(
      async (_id: string, _type: string, after: number) =>
        after > 0
          ? []
          : [
              {
                sequence: 1,
                entityType: 'contribution_revision',
                stableId: 'contribution-stable-id',
                versionId: 'revision-immutable-id',
                journalDate: '2026-08-25',
                payloadJson:
                  '{"authority":"manual","duration_bytes":9007199254740993,"mood":{"state":"neutral"},"text":"Private fixture"}',
              },
            ],
    );
    repository.journalDates
      .mockResolvedValueOnce(['2026-08-25'])
      .mockResolvedValueOnce([]);
    repository.markdownItems.mockResolvedValue([]);
    repository.blobLeases.mockResolvedValue([]);
    repository.complete.mockResolvedValue(true);
  });

  it('[PORT-005][PORT-007][AC-050][AC-051][AC-052] preserves stable relationships, semantic absence, manual authority, and historical provider provenance verbatim', () => {
    const line = serializeSnapshotItem({
      entityType: 'processor_artifact_version',
      stableId: 'artifact-id',
      versionId: 'artifact-version-id',
      journalDate: '2026-08-25',
      payload: {
        authority: 'manual',
        value: { state: 'unknown' },
        provider_id: 'provider-before-switch',
        model_id: 'model-v1',
        prompt_template_hash: 'a'.repeat(64),
        processing_time_ms: 42,
      },
    });
    expect(JSON.parse(line)).toEqual(
      expect.objectContaining({
        stableId: 'artifact-id',
        versionId: 'artifact-version-id',
        data: expect.objectContaining({
          authority: 'manual',
          value: { state: 'unknown' },
          provider_id: 'provider-before-switch',
          model_id: 'model-v1',
        }),
      }),
    );
  });

  it('[PORT-004][AC-050] preserves unbounded PostgreSQL JSON numeric tokens without Number coercion', () => {
    const line = serializeSnapshotDatabaseItem({
      entityType: 'recording',
      stableId: 'recording-id',
      versionId: null,
      journalDate: '2026-08-25',
      payloadJson: '{"final_byte_size":9007199254740993}',
    });
    expect(line).toContain('"final_byte_size":9007199254740993');
  });

  it('[PORT-003][PORT-004][AC-050] emits a ZIP64 archive with JSONL, Markdown, and checksummed versioned manifest entries', async () => {
    let archiveBytes = Buffer.alloc(0);
    const blobs = {
      putImmutable: vi.fn(
        async (input: AsyncIterable<Uint8Array>, metadata: { key: string }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of input) chunks.push(Buffer.from(chunk));
          archiveBytes = Buffer.concat(chunks);
          return {
            key: metadata.key,
            byteSize: BigInt(archiveBytes.byteLength),
            sha256: createHash('sha256').update(archiveBytes).digest('hex'),
            modifiedAt: new Date(),
          };
        },
      ),
      delete: vi.fn(),
    } as unknown as BlobStore;
    const handler = new ExportJobHandler({} as DatabaseClient, blobs);
    await handler.execute(
      { exportId: EXPORT_ID },
      new AbortController().signal,
    );
    expect(archiveBytes.subarray(0, 4).toString('hex')).toBe('504b0304');
    const entries = zipEntries(archiveBytes);
    const manifestBytes = entries.get('manifest.json');
    const manifestChecksum = entries.get('manifest.sha256');
    expect(manifestBytes).toBeDefined();
    if (manifestBytes === undefined) throw new Error('Manifest is missing.');
    expect(manifestChecksum?.toString('utf8')).toBe(
      `${createHash('sha256').update(manifestBytes).digest('hex')}  manifest.json\n`,
    );
    const manifest = JSON.parse(manifestBytes.toString('utf8')) as {
      archiveFormat: string;
      manifestSchemaVersion: number;
      files: Array<{
        path: string;
        byteSize: string;
        sha256: string;
      }>;
    };
    expect(manifest).toMatchObject({
      archiveFormat: 'journal-portable-export',
      manifestSchemaVersion: 1,
    });
    for (const file of manifest.files) {
      const extracted = entries.get(file.path);
      expect(extracted, file.path).toBeDefined();
      if (extracted === undefined)
        throw new Error(`Archive entry ${file.path} is missing.`);
      expect(BigInt(extracted.byteLength), file.path).toBe(
        BigInt(file.byteSize),
      );
      expect(
        createHash('sha256').update(extracted).digest('hex'),
        file.path,
      ).toBe(file.sha256);
    }
    expect(
      entries.get('data/contribution_revision.jsonl')?.toString('utf8'),
    ).toContain('"duration_bytes":9007199254740993');
    expect(entries.has('journal/2026-08-25.md')).toBe(true);
    expect(repository.complete).toHaveBeenCalledWith(
      EXPORT_ID,
      expect.objectContaining({
        sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
      4,
      expect.any(Date),
    );
  });

  it('[PORT-004][MODEL-006][AC-050][AC-052] streams selected audio and retained provider bodies at stable paths after checksum verification', async () => {
    const audio = Buffer.from('synthetic-audio-bytes');
    const raw = Buffer.from('{"synthetic":"provider-response"}');
    repository.blobLeases
      .mockResolvedValueOnce([
        {
          archivePath: 'audio/recording-id/original',
          blobKind: 'audio',
          blobKey: 'source/audio',
          mediaType: 'audio/webm',
          byteSize: BigInt(audio.byteLength),
          sha256: createHash('sha256').update(audio).digest('hex'),
        },
        {
          archivePath: 'provider-raw/raw-response-id.json',
          blobKind: 'provider_raw_response',
          blobKey: 'source/raw-response',
          mediaType: 'application/json',
          byteSize: BigInt(raw.byteLength),
          sha256: createHash('sha256').update(raw).digest('hex'),
        },
      ])
      .mockResolvedValueOnce([]);
    let archiveBytes = Buffer.alloc(0);
    const blobs = {
      open: vi.fn(async (key: string) => {
        const value = key === 'source/audio' ? audio : raw;
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(value);
            controller.close();
          },
        });
      }),
      putImmutable: vi.fn(
        async (input: AsyncIterable<Uint8Array>, metadata: { key: string }) => {
          const chunks: Buffer[] = [];
          for await (const chunk of input) chunks.push(Buffer.from(chunk));
          archiveBytes = Buffer.concat(chunks);
          return {
            key: metadata.key,
            byteSize: BigInt(archiveBytes.byteLength),
            sha256: createHash('sha256').update(archiveBytes).digest('hex'),
            modifiedAt: new Date(),
          };
        },
      ),
      delete: vi.fn(),
    } as unknown as BlobStore;

    await new ExportJobHandler({} as DatabaseClient, blobs).execute(
      { exportId: EXPORT_ID },
      new AbortController().signal,
    );

    const entries = zipEntries(archiveBytes);
    expect(entries.get('audio/recording-id/original.webm')).toEqual(audio);
    expect(entries.get('provider-raw/raw-response-id.json')).toEqual(raw);
  });

  it('[PORT-003][RET-007] removes an incomplete hosted archive and marks the request failed when the sink terminates early', async () => {
    repository.entityTypes.mockResolvedValue([]);
    repository.journalDates.mockResolvedValue([]);
    const blobs = {
      putImmutable: vi.fn(
        async (
          _input: AsyncIterable<Uint8Array>,
          metadata: { key: string },
        ) => ({
          key: metadata.key,
          byteSize: 0n,
          sha256: '0'.repeat(64),
          modifiedAt: new Date(),
        }),
      ),
      delete: vi.fn(),
    } as unknown as BlobStore;

    await expect(
      new ExportJobHandler({} as DatabaseClient, blobs).execute(
        { exportId: EXPORT_ID },
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ disposition: 'transient' });

    expect(blobs.delete).toHaveBeenCalledWith(
      `exports/${OWNER_ID}/${EXPORT_ID}/journal-export.zip`,
    );
    expect(repository.fail).toHaveBeenCalledWith(
      EXPORT_ID,
      'Error',
      expect.any(Date),
    );
  });

  it('[STATE-001][RET-006] accepts only identifier jobs and does not publish an invalidated stream', async () => {
    const handler = new ExportJobHandler({} as DatabaseClient, {} as BlobStore);
    await expect(
      handler.load(
        createQueueJobPayload({
          identifiers: { exportId: EXPORT_ID },
          operation: 'export',
          queueName: queueNames.export,
        }),
      ),
    ).resolves.toEqual({ input: { exportId: EXPORT_ID }, state: 'runnable' });
    await expect(
      handler.load(
        createQueueJobPayload({
          identifiers: { exportId: EXPORT_ID },
          operation: 'backup',
          queueName: queueNames.export,
        }),
      ),
    ).rejects.toMatchObject({ disposition: 'permanent' });
  });
});
