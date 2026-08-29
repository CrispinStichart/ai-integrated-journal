import {
  ExportRepository,
  QueueJobError,
  RetentionRepository,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import { BlobNotFoundError, type BlobStore } from '@journal/storage';
import { createUuidV7 } from '@journal/domain';
import type { PgBoss } from 'pg-boss';

export const RETENTION_OPERATION = 'retention';
export const RETENTION_REQUEST_OPERATION = 'retention_request';

type RetentionWork = Readonly<{ requestId?: string }>;

/**
 * Content-free queue work reloads canonical rows and deletes blobs in pages.
 * Missing blobs are successful idempotent retries; other adapter failures leave
 * the request retryable and SQL content untouched behind its tombstone.
 */
export class RetentionJobHandler implements CanonicalJobHandler<RetentionWork> {
  readonly #repository: RetentionRepository;
  readonly #exports: ExportRepository;

  public constructor(
    database: DatabaseClient,
    private readonly blobs: BlobStore,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new RetentionRepository(database.database);
    this.#exports = new ExportRepository(database.database);
  }

  public async load(
    payload: QueueJobPayload,
  ): Promise<CanonicalJobInput<RetentionWork>> {
    if (payload.operation === RETENTION_OPERATION) {
      if (payload.identifiers.scheduleKey !== 'retention.daily')
        throw new QueueJobError(
          'permanent',
          'Unsupported retention schedule payload.',
        );
      return { input: {}, state: 'runnable' };
    }
    if (payload.operation === RETENTION_REQUEST_OPERATION) {
      const requestId = payload.identifiers.requestId;
      if (requestId === undefined)
        throw new QueueJobError(
          'permanent',
          'Retention request identity is missing.',
        );
      return { input: { requestId }, state: 'runnable' };
    }
    throw new QueueJobError('permanent', 'Unsupported retention payload.');
  }

  public async execute(
    work: RetentionWork,
    signal: AbortSignal,
  ): Promise<void> {
    const now = this.now();
    if (work.requestId === undefined) {
      await this.expireExports(now, signal);
      for (const target of await this.#repository.expiredRawResponses(now)) {
        await this.#repository.request({
          id: createUuidV7<'permanent-deletion'>(),
          tombstoneId: createUuidV7<'deletion-tombstone'>(),
          ownerId: target.ownerId,
          entityKind: 'provider_raw_response',
          entityId: target.entityId,
          correlationId: createUuidV7<'correlation'>(),
          requestedAt: now,
        });
      }
    }
    for (let count = 0; count < 100; count += 1) {
      const request = await this.#repository.claim(this.now(), work.requestId);
      if (request === undefined) return;
      await this.purge(request.id, signal);
      if (work.requestId !== undefined) return;
    }
  }

  private async expireExports(now: Date, signal: AbortSignal): Promise<void> {
    for (;;) {
      signal.throwIfAborted();
      const due = await this.#exports.expireDue(now);
      if (due.length === 0) return;
      for (const item of due) {
        signal.throwIfAborted();
        if (item.archiveBlobKey === null) continue;
        try {
          await this.blobs.delete(item.archiveBlobKey);
        } catch (error) {
          if (!(error instanceof BlobNotFoundError)) throw error;
        }
        await this.#exports.markHostedArchiveDeleted(
          item.id,
          item.archiveBlobKey,
          this.now(),
        );
      }
    }
  }

  private async purge(requestId: string, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        if (signal.aborted) signal.throwIfAborted();
        const items = await this.#repository.blobItems(requestId);
        if (items.length === 0) break;
        for (const item of items) {
          if (signal.aborted) signal.throwIfAborted();
          try {
            await this.blobs.delete(item.blobKey);
          } catch (error) {
            if (!(error instanceof BlobNotFoundError)) throw error;
          }
          await this.#repository.markBlobDeleted(
            requestId,
            item.blobKey,
            this.now(),
          );
        }
      }
      await this.#repository.complete(requestId, this.now());
    } catch (error) {
      await this.#repository.markFailed(
        requestId,
        error instanceof Error ? error.name : 'unknown_error',
        this.now(),
      );
      throw new QueueJobError(
        'transient',
        'Permanent deletion cleanup failed.',
      );
    }
  }
}

export function registerRetentionConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly blobs: BlobStore;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.maintenance,
    handler: new RetentionJobHandler(input.database, input.blobs),
  });
}
