import type { CreateExportRequest, ExportResource } from '@journal/contracts';
import { ExportRepository } from '@journal/database';
import { canDownloadExport, createUuidV7 } from '@journal/domain';
import type { BlobStore } from '@journal/storage';
import type { PgBoss } from 'pg-boss';

export interface ExportDownload {
  readonly body: ReadableStream<Uint8Array>;
  readonly byteSize: bigint;
  readonly sha256: string;
}

export interface ExportService {
  create(
    ownerId: string,
    request: CreateExportRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<{ readonly export: ExportResource; readonly replayed: boolean }>;
  get(ownerId: string, id: string): Promise<ExportResource | undefined>;
  list(ownerId: string): Promise<ExportResource[]>;
  download(
    ownerId: string,
    id: string,
    correlationId: string,
  ): Promise<ExportDownload | undefined>;
}

export class PostgresExportService implements ExportService {
  readonly #repository: ExportRepository;

  public constructor(
    database: ConstructorParameters<typeof ExportRepository>[0],
    private readonly boss: PgBoss,
    private readonly blobs: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new ExportRepository(database);
  }

  public async create(
    ownerId: string,
    request: CreateExportRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const id = createUuidV7<'export'>();
    const result = await this.#repository.createSnapshot({
      id,
      ownerId,
      includeAudio: request.includeAudio,
      includeProviderRawResponses: request.includeProviderRawResponses,
      now: this.now,
      correlationId,
      boss: this.boss,
      idempotencyKey,
    });
    return {
      export: mapExport(result.row, this.now()),
      replayed: result.replayed,
    };
  }

  public async get(ownerId: string, id: string) {
    const row = await this.#repository.get(ownerId, id);
    return row === undefined ? undefined : mapExport(row, this.now());
  }

  public async list(ownerId: string) {
    return (await this.#repository.list(ownerId)).map((row) =>
      mapExport(row, this.now()),
    );
  }

  public async download(
    ownerId: string,
    id: string,
    correlationId: string,
  ): Promise<ExportDownload | undefined> {
    const row = await this.#repository.get(ownerId, id);
    if (
      row === undefined ||
      !canDownloadExport({
        status: row.status,
        expiresAt: row.expiresAt,
        now: this.now(),
        archiveBlobKey: row.archiveBlobKey,
      }) ||
      row.archiveBlobKey === null ||
      row.archiveByteSize === null ||
      row.archiveSha256 === null
    )
      return undefined;
    const body = await this.blobs.open(row.archiveBlobKey);
    await this.#repository.recordDownload({
      ownerId,
      exportId: id,
      correlationId,
      occurredAt: this.now(),
    });
    return {
      body,
      byteSize: row.archiveByteSize,
      sha256: row.archiveSha256,
    };
  }
}

function mapExport(
  row: Awaited<ReturnType<ExportRepository['get']>> extends infer T
    ? Exclude<T, undefined>
    : never,
  now: Date,
): ExportResource {
  const downloadAvailable = canDownloadExport({
    status: row.status,
    expiresAt: row.expiresAt,
    now,
    archiveBlobKey: row.archiveBlobKey,
  });
  return {
    id: row.id,
    status: row.status,
    manifestSchemaVersion: 1,
    snapshotAt: row.snapshotAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    includeAudio: row.includeAudio,
    includeProviderRawResponses: row.includeProviderRawResponses,
    entityCount: row.entityCount,
    fileCount: row.fileCount,
    ...(row.archiveByteSize === null
      ? {}
      : { archiveByteSize: row.archiveByteSize.toString() }),
    ...(row.archiveSha256 === null ? {} : { archiveSha256: row.archiveSha256 }),
    ...(row.completedAt === null
      ? {}
      : { completedAt: row.completedAt.toISOString() }),
    ...(row.invalidatedAt === null
      ? {}
      : { invalidatedAt: row.invalidatedAt.toISOString() }),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
    downloadAvailable,
  };
}
