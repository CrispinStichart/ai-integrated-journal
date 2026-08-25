import { BlobNotFoundError, type BlobStore } from '@journal/storage';
import type { DatabaseClient } from '@journal/database';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const repository = {
  expiredRawResponses: vi.fn<
    () => Promise<Array<{ ownerId: string; entityId: string }>>
  >(async () => []),
  request: vi.fn(),
  claim: vi.fn(),
  blobItems: vi.fn(),
  markBlobDeleted: vi.fn(),
  complete: vi.fn(),
  markFailed: vi.fn(),
};

vi.mock('@journal/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@journal/database')>()),
  RetentionRepository: function RetentionRepository() {
    return repository;
  },
}));

import { createQueueJobPayload, queueNames } from '@journal/database';
import { RetentionJobHandler } from '../src/retention.js';

const REQUEST_ID = '019d2b3c-4000-7000-8000-000000000003';
const OWNER_ID = '019d2b3c-4000-7000-8000-000000000001';
const RAW_RESPONSE_ID = '019d2b3c-4000-7000-8000-000000000002';

describe('retention worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repository.expiredRawResponses.mockResolvedValue([]);
  });

  it('[RET-006][RET-007] accepts only identifier-only scheduled or request work', async () => {
    const handler = new RetentionJobHandler(
      {} as DatabaseClient,
      {} as BlobStore,
    );
    await expect(
      handler.load(
        createQueueJobPayload({
          identifiers: { requestId: REQUEST_ID },
          operation: 'retention_request',
          queueName: queueNames.maintenance,
        }),
      ),
    ).resolves.toEqual({ input: { requestId: REQUEST_ID }, state: 'runnable' });
    await expect(
      handler.load(
        createQueueJobPayload({
          identifiers: { scheduleKey: 'retention.daily' },
          operation: 'retention',
          queueName: queueNames.maintenance,
        }),
      ),
    ).resolves.toEqual({ input: {}, state: 'runnable' });
    await expect(
      handler.load(
        createQueueJobPayload({
          identifiers: { scheduleKey: 'backup.daily' },
          operation: 'retention',
          queueName: queueNames.maintenance,
        }),
      ),
    ).rejects.toMatchObject({ disposition: 'permanent' });
  });

  it('[RET-006][RET-007] treats missing blobs as idempotent success and completes SQL only after every key', async () => {
    repository.claim.mockResolvedValueOnce({ id: REQUEST_ID });
    repository.blobItems
      .mockResolvedValueOnce([
        { blobKey: 'audio/missing.audio' },
        { blobKey: 'staging/present.chunk' },
      ])
      .mockResolvedValueOnce([]);
    const blobs = {
      delete: vi
        .fn()
        .mockRejectedValueOnce(new BlobNotFoundError())
        .mockResolvedValueOnce(undefined),
    } as unknown as BlobStore;
    const handler = new RetentionJobHandler({} as DatabaseClient, blobs);

    await handler.execute(
      { requestId: REQUEST_ID },
      new AbortController().signal,
    );

    expect(repository.markBlobDeleted).toHaveBeenCalledTimes(2);
    expect(repository.complete).toHaveBeenCalledWith(
      REQUEST_ID,
      expect.any(Date),
    );
    expect(repository.markFailed).not.toHaveBeenCalled();
  });

  it('[RET-006] leaves SQL material retryable when object-store deletion fails', async () => {
    repository.claim.mockResolvedValueOnce({ id: REQUEST_ID });
    repository.blobItems.mockResolvedValueOnce([
      { blobKey: 'audio/fails.audio' },
    ]);
    const blobs = {
      delete: vi.fn(async () => {
        throw new Error('adapter unavailable');
      }),
    } as unknown as BlobStore;
    const handler = new RetentionJobHandler({} as DatabaseClient, blobs);

    await expect(
      handler.execute({ requestId: REQUEST_ID }, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'transient' });
    expect(repository.markFailed).toHaveBeenCalledWith(
      REQUEST_ID,
      'Error',
      expect.any(Date),
    );
    expect(repository.complete).not.toHaveBeenCalled();
  });

  it('[MODEL-006][RET-006] schedules expired raw responses as tombstoned, identifier-only deletions', async () => {
    const now = new Date('2026-08-25T00:00:00.000Z');
    repository.expiredRawResponses.mockResolvedValueOnce([
      { ownerId: OWNER_ID, entityId: RAW_RESPONSE_ID },
    ]);
    repository.request.mockResolvedValueOnce({});
    repository.claim.mockResolvedValueOnce(undefined);
    const handler = new RetentionJobHandler(
      {} as DatabaseClient,
      {} as BlobStore,
      () => now,
    );

    await handler.execute({}, new AbortController().signal);

    expect(repository.request).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        entityKind: 'provider_raw_response',
        entityId: RAW_RESPONSE_ID,
        requestedAt: now,
      }),
    );
    expect(repository.claim).toHaveBeenCalledWith(now, undefined);
  });
});
