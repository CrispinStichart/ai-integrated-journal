import { createHash } from 'node:crypto';
import { PassThrough, Readable } from 'node:stream';

import {
  ExportRepository,
  QueueJobError,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type DatabaseClient,
  type ExportBlobLeaseRow,
  type QueueJobPayload,
} from '@journal/database';
import {
  EXPORT_ARCHIVE_FORMAT,
  EXPORT_MANIFEST_SCHEMA_VERSION,
  safeExportPathSegment,
} from '@journal/domain';
import type { BlobStore } from '@journal/storage';
import archiver, { type Archiver } from 'archiver';
import type { PgBoss } from 'pg-boss';

export const EXPORT_OPERATION = 'export';
const encoder = new TextEncoder();

interface ExportWork {
  readonly exportId: string;
}
interface FileDigest {
  readonly path: string;
  readonly sha256: string;
  readonly byteSize: string;
  readonly mediaType: string;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Readonly<Record<string, unknown>>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

async function* webStream(
  stream: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const result = await reader.read();
      if (result.done) return;
      yield result.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function digestingReadable(
  source: AsyncIterable<Uint8Array>,
  digest: { hash?: string; bytes: bigint },
): Readable {
  return Readable.from(
    (async function* () {
      const hash = createHash('sha256');
      for await (const chunk of source) {
        hash.update(chunk);
        digest.bytes += BigInt(chunk.byteLength);
        yield chunk;
      }
      digest.hash = hash.digest('hex');
    })(),
  );
}

async function appendStream(
  archive: Archiver,
  path: string,
  mediaType: string,
  source: AsyncIterable<Uint8Array>,
  sinkCompletion: Promise<unknown>,
): Promise<FileDigest> {
  const digest: { hash?: string; bytes: bigint } = { bytes: 0n };
  const completed = new Promise<void>((resolve, reject) => {
    const onEntry = (entry: { name: string }) => {
      if (entry.name !== path) return;
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      archive.off('entry', onEntry);
      archive.off('error', onError);
    };
    archive.on('entry', onEntry);
    archive.on('error', onError);
  });
  archive.append(digestingReadable(source, digest), {
    name: path,
    store: false,
  });
  await Promise.race([
    completed,
    sinkCompletion.then(() => {
      throw new Error('Archive sink completed before ZIP finalization.');
    }),
  ]);
  if (digest.hash === undefined)
    throw new Error('Entry checksum was not finalized.');
  return {
    path,
    mediaType,
    byteSize: digest.bytes.toString(),
    sha256: digest.hash,
  };
}

async function* bytes(value: string): AsyncGenerator<Uint8Array> {
  yield encoder.encode(value);
}

export function inertMarkdownBlock(value: string, language = 'text'): string {
  let longestRun = 0;
  for (const match of value.matchAll(/`+/gu)) {
    longestRun = Math.max(longestRun, match[0].length);
  }
  const fence = '`'.repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${value}${value.endsWith('\n') ? '' : '\n'}${fence}`;
}

function markdownValue(value: unknown): string {
  return inertMarkdownBlock(
    typeof value === 'string' ? value : canonicalJson(value),
    typeof value === 'string' ? 'text' : 'json',
  );
}

async function* jsonLines(
  repository: ExportRepository,
  exportId: string,
  entityType: string,
): AsyncGenerator<Uint8Array> {
  let after = 0;
  for (;;) {
    const page = await repository.jsonLineItems(exportId, entityType, after);
    if (page.length === 0) return;
    for (const item of page) {
      yield encoder.encode(`${serializeSnapshotDatabaseItem(item)}\n`);
      after = item.sequence;
    }
  }
}

export function serializeSnapshotDatabaseItem(item: {
  readonly entityType: string;
  readonly stableId: string;
  readonly versionId: string | null;
  readonly journalDate: string | null;
  readonly payloadJson: string;
}): string {
  return `{"data":${item.payloadJson},"entityType":${JSON.stringify(item.entityType)},"journalDate":${JSON.stringify(item.journalDate)},"stableId":${JSON.stringify(item.stableId)},"versionId":${JSON.stringify(item.versionId)}}`;
}

export function serializeSnapshotItem(item: {
  readonly entityType: string;
  readonly stableId: string;
  readonly versionId: string | null;
  readonly journalDate: string | null;
  readonly payload: Readonly<Record<string, unknown>>;
}): string {
  return canonicalJson({
    entityType: item.entityType,
    stableId: item.stableId,
    versionId: item.versionId,
    journalDate: item.journalDate,
    data: item.payload,
  });
}

async function* journalMarkdown(
  repository: ExportRepository,
  exportId: string,
  journalDate: string,
): AsyncGenerator<Uint8Array> {
  yield encoder.encode(
    `# Journal Day ${journalDate}\n\nPoint-in-time portable view. Stable identifiers are included for cross-reference with JSON Lines.\n\n`,
  );
  let after = 0;
  for (;;) {
    const page = await repository.markdownItems(exportId, journalDate, after);
    if (page.length === 0) return;
    for (const item of page) {
      after = item.sequence;
      if (
        item.entityType === 'journal_day' ||
        item.entityType === 'contribution' ||
        item.entityType === 'transcript' ||
        item.entityType === 'processor_artifact'
      )
        continue;
      const payload = item.payload;
      if (item.entityType === 'contribution_revision') {
        yield encoder.encode(
          `## Contribution ${item.stableId} · revision ${String(payload.revision ?? item.versionId)}\n\nAuthority: **${String(payload.authority ?? 'unknown')}**\n\n${inertMarkdownBlock(String(payload.text ?? ''))}\n\n`,
        );
      } else if (item.entityType === 'transcript_revision') {
        yield encoder.encode(
          `## Transcript ${item.stableId} · revision ${String(payload.revision ?? item.versionId)}\n\nLayer authority: **${String(payload.authority ?? 'unknown')}**\n\n${inertMarkdownBlock(String(payload.text ?? ''))}\n\n`,
        );
      } else if (item.entityType === 'processor_artifact_version') {
        yield encoder.encode(
          `## Result ${item.stableId} · version ${String(payload.revision ?? item.versionId)}\n\nAuthority: **${String(payload.authority ?? 'generated')}** · lifecycle: **${String(payload.lifecycle ?? 'unknown')}**\n\n${markdownValue(payload.payload)}\n\n`,
        );
      }
    }
  }
}

function blobExtension(lease: ExportBlobLeaseRow): string {
  if (lease.blobKind === 'provider_raw_response') return '.json';
  if (lease.mediaType.includes('webm')) return '.webm';
  if (lease.mediaType.includes('ogg')) return '.ogg';
  if (lease.mediaType.includes('mpeg')) return '.mp3';
  if (lease.mediaType.includes('wav')) return '.wav';
  return '.audio';
}

export class ExportJobHandler implements CanonicalJobHandler<ExportWork> {
  readonly #repository: ExportRepository;

  public constructor(
    database: DatabaseClient,
    private readonly blobs: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new ExportRepository(database.database);
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<ExportWork>> {
    if (
      payload.operation !== EXPORT_OPERATION ||
      payload.identifiers.exportId === undefined
    ) {
      throw new QueueJobError('permanent', 'Unsupported export payload.');
    }
    return {
      input: { exportId: payload.identifiers.exportId },
      state: 'runnable',
    };
  }

  public async execute(work: ExportWork, signal: AbortSignal): Promise<void> {
    const request = await this.#repository.claim(work.exportId, this.now());
    if (request === undefined) return;
    const archiveKey = `exports/${request.ownerId}/${request.id}/journal-export.zip`;
    const output = new PassThrough({ highWaterMark: 256 * 1024 });
    const archive = archiver('zip', { forceZip64: true, zlib: { level: 6 } });
    archive.pipe(output);
    const storedPromise = this.blobs.putImmutable(output, { key: archiveKey });
    void storedPromise.catch(() => undefined);
    const files: FileDigest[] = [];
    try {
      for (const entity of await this.#repository.entityTypes(request.id)) {
        signal.throwIfAborted();
        await this.#repository.assertRunnable(request.id);
        files.push(
          await appendStream(
            archive,
            `data/${safeExportPathSegment(entity.entityType)}.jsonl`,
            'application/x-ndjson',
            jsonLines(this.#repository, request.id, entity.entityType),
            storedPromise,
          ),
        );
      }
      let afterJournalDate = '';
      for (;;) {
        const journalDates = await this.#repository.journalDates(
          request.id,
          afterJournalDate,
        );
        if (journalDates.length === 0) break;
        for (const journalDate of journalDates) {
          signal.throwIfAborted();
          await this.#repository.assertRunnable(request.id);
          files.push(
            await appendStream(
              archive,
              `journal/${journalDate}.md`,
              'text/markdown; charset=utf-8',
              journalMarkdown(this.#repository, request.id, journalDate),
              storedPromise,
            ),
          );
          afterJournalDate = journalDate;
        }
      }
      let afterBlobPath = '';
      for (;;) {
        const leases = await this.#repository.blobLeases(
          request.id,
          afterBlobPath,
        );
        if (leases.length === 0) break;
        for (const lease of leases) {
          signal.throwIfAborted();
          await this.#repository.assertRunnable(request.id);
          const path = `${lease.archivePath}${lease.blobKind === 'audio' ? blobExtension(lease) : ''}`;
          const digest = await appendStream(
            archive,
            path,
            lease.mediaType,
            webStream(await this.blobs.open(lease.blobKey)),
            storedPromise,
          );
          if (
            digest.sha256 !== lease.sha256 ||
            BigInt(digest.byteSize) !== lease.byteSize
          )
            throw new Error('Leased blob failed integrity verification.');
          files.push(digest);
          afterBlobPath = lease.archivePath;
        }
      }
      const entityTypes = await this.#repository.entityTypes(request.id);
      const manifest = `${canonicalJson({
        archiveFormat: EXPORT_ARCHIVE_FORMAT,
        manifestSchemaVersion: EXPORT_MANIFEST_SCHEMA_VERSION,
        exportId: request.id,
        snapshotAt: request.snapshotAt.toISOString(),
        createdAt: request.createdAt.toISOString(),
        expiresAt: request.expiresAt.toISOString(),
        selection: {
          audio: request.includeAudio,
          providerRawResponses: request.includeProviderRawResponses,
        },
        evidenceCoordinates: {
          normalization: 'NFC_LF_V1',
          offsetUnit: 'utf16_code_unit',
        },
        semanticStates: [
          'unknown',
          'known',
          'none',
          'neutral',
          'not_applicable',
          'uncertain',
        ],
        authorityStates: ['manual', 'generated'],
        relationships: {
          stableId: 'stableId',
          immutableVersionId: 'versionId',
        },
        entityTypes,
        files,
      })}\n`;
      const manifestDigest = await appendStream(
        archive,
        'manifest.json',
        'application/json',
        bytes(manifest),
        storedPromise,
      );
      files.push(manifestDigest);
      await appendStream(
        archive,
        'manifest.sha256',
        'text/plain; charset=utf-8',
        bytes(`${manifestDigest.sha256}  manifest.json\n`),
        storedPromise,
      );
      await archive.finalize();
      const stored = await storedPromise;
      const completed = await this.#repository.complete(
        request.id,
        {
          key: stored.key,
          byteSize: stored.byteSize,
          sha256: stored.sha256,
        },
        files.length + 1,
        this.now(),
      );
      if (!completed) {
        await this.blobs.delete(stored.key);
        throw new QueueJobError(
          'permanent',
          'Export was invalidated while streaming.',
        );
      }
    } catch (error) {
      archive.abort();
      output.destroy();
      try {
        const stored = await storedPromise;
        await this.blobs.delete(stored.key);
      } catch {
        // The adapter owns cleanup of a failed immutable write.
      }
      await this.#repository.fail(
        request.id,
        error instanceof Error ? error.name : 'unknown_error',
        this.now(),
      );
      if (error instanceof QueueJobError) throw error;
      throw new QueueJobError('transient', 'Export archive generation failed.');
    }
  }
}

export function registerExportConsumer(input: {
  boss: PgBoss;
  database: DatabaseClient;
  blobs: BlobStore;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.export,
    handler: new ExportJobHandler(input.database, input.blobs),
  });
}
