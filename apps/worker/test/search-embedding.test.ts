import {
  SEARCH_EMBEDDING_DISPATCH_OPERATION,
  SEARCH_EMBEDDING_DISPATCH_SCHEDULE_KEY,
  SEARCH_EMBEDDING_OPERATION,
  SearchEmbeddingRepository,
  createQueueJobPayload,
  queueNames,
  type DatabaseClient,
  type SearchEmbeddingRequestRecord,
} from '@journal/database';
import { AiProviderOperationError, type EmbeddingRequest } from '@journal/ai';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { SearchEmbeddingJobHandler } from '../src/search-embedding.js';

const FRAGMENT_ID = '019c5b90-0000-7000-8000-000000000801';
const JOB_ID = '019c5b90-0000-7000-8000-000000000802';
const request: SearchEmbeddingRequestRecord = {
  fragmentId: FRAGMENT_ID,
  ownerId: '019c5b90-0000-7000-8000-000000000803',
  generation: 2,
  status: 'dispatched',
  jobId: JOB_ID,
  cohortId: null,
  nextChunkIndex: 0,
  nextCharacter: 1,
  contentCharacters: 12,
};

function payload() {
  return createQueueJobPayload({
    queueName: queueNames.search,
    operation: SEARCH_EMBEDDING_OPERATION,
    identifiers: {
      fragmentId: FRAGMENT_ID,
      requestId: FRAGMENT_ID,
      generationKey: '2',
    },
  });
}

function repository(overrides: Partial<SearchEmbeddingRepository> = {}) {
  return {
    load: vi.fn(async () => request),
    dispatchPending: vi.fn(async () => []),
    markRunning: vi.fn(async () => true),
    readChunk: vi.fn(async () => ({
      text: 'safe fixture',
      chunkIndex: 0,
      startCharacter: 1,
      endCharacter: 12,
    })),
    persistChunk: vi.fn(async () => 'cohort-id'),
    markSucceeded: vi.fn(async () => undefined),
    markPendingContinuation: vi.fn(async () => undefined),
    markUnavailable: vi.fn(async () => undefined),
    markFailed: vi.fn(async () => undefined),
    ...overrides,
  } as unknown as SearchEmbeddingRepository;
}

function available() {
  return Promise.resolve({
    status: 'available' as const,
    port: {
      embed: vi.fn(async (embeddingRequest: EmbeddingRequest) => ({
        embeddings: [
          {
            fragmentId: embeddingRequest.fragments[0]?.id ?? 'missing',
            vector: [1, 0, 0, 0],
          },
        ],
        dimension: 4,
        usage: { status: 'unknown' as const },
        operation: {
          provider: { id: 'fixture', displayName: 'Fixture' },
          model: { id: 'semantic-v1', version: '1' },
          configuration: {
            parameters: {},
            fingerprint: 'a'.repeat(64),
          },
          processingTimeMs: 1,
        },
        rawResponse: { body: new Uint8Array(), mediaType: 'application/json' },
      })),
    },
  });
}

describe('search embedding identifier-only worker', () => {
  it('[SEARCH-002][SEARCH-006][SEC-007] dispatches lifecycle requests and reloads fragment content outside queue payloads', async () => {
    const repo = repository();
    const handler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      available,
      repo,
    );
    const dispatchPayload = createQueueJobPayload({
      queueName: queueNames.search,
      operation: SEARCH_EMBEDDING_DISPATCH_OPERATION,
      identifiers: {
        scheduleKey: SEARCH_EMBEDDING_DISPATCH_SCHEDULE_KEY,
      },
    });
    const dispatch = await handler.load(dispatchPayload);
    expect(JSON.stringify(dispatchPayload)).not.toContain('safe fixture');
    if (dispatch.input === undefined) throw new Error('dispatch input missing');
    await handler.execute(dispatch.input, new AbortController().signal);
    expect(repo.dispatchPending).toHaveBeenCalled();

    const loaded = await handler.load(payload());
    expect(loaded.state).toBe('runnable');
    if (loaded.input === undefined) throw new Error('embedding input missing');
    await handler.execute(loaded.input, new AbortController().signal);
    expect(repo.markRunning).toHaveBeenCalledWith(FRAGMENT_ID, 2, JOB_ID);
    expect(repo.persistChunk).toHaveBeenCalledWith(
      expect.objectContaining({
        request,
        vector: [1, 0, 0, 0],
        cohort: expect.objectContaining({
          providerId: 'fixture',
          modelId: 'semantic-v1',
          dimension: 4,
        }),
      }),
    );
    expect(repo.markSucceeded).toHaveBeenCalledWith(FRAGMENT_ID, 2, JOB_ID);
  });

  it('[ARCH-005][MODEL-004][SEARCH-002] records capability absence without retrying or affecting lexical search', async () => {
    const repo = repository();
    const handler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      async () => ({
        status: 'unavailable',
        providerId: 'disabled',
        capability: 'embeddings',
        reason: 'provider_disabled',
      }),
      repo,
    );
    const loaded = await handler.load(payload());
    if (loaded.input === undefined) throw new Error('embedding input missing');
    await handler.execute(loaded.input, new AbortController().signal);
    expect(repo.markUnavailable).toHaveBeenCalledWith(
      FRAGMENT_ID,
      2,
      JOB_ID,
      'provider_disabled',
    );
    expect(repo.readChunk).not.toHaveBeenCalled();
  });

  it('[SEARCH-002][STATE-003] bounds each attempt and leaves oversized exact revisions ready for continuation', async () => {
    const continuingRequest = {
      ...request,
      contentCharacters: 40_000,
    };
    const repo = repository({
      load: vi.fn(async () => continuingRequest),
      readChunk: vi.fn(async (_fragmentId, startCharacter, chunkIndex) => ({
        text: 'x'.repeat(2_000),
        chunkIndex,
        startCharacter,
        endCharacter: startCharacter + 1_999,
      })),
    });
    const handler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      available,
      repo,
    );
    const loaded = await handler.load(payload());
    if (loaded.input === undefined) throw new Error('embedding input missing');
    await handler.execute(loaded.input, new AbortController().signal);
    expect(repo.readChunk).toHaveBeenCalledTimes(16);
    expect(repo.persistChunk).toHaveBeenCalledTimes(16);
    expect(repo.markPendingContinuation).toHaveBeenCalledWith(
      FRAGMENT_ID,
      2,
      JOB_ID,
    );
    expect(repo.markSucceeded).not.toHaveBeenCalled();
  });

  it('[SEARCH-002][STATE-003–STATE-004] cancels obsolete generations and marks malformed provider vectors as permanent failures', async () => {
    const obsolete = repository({
      load: vi.fn(async () => ({ ...request, generation: 3 })),
    });
    const obsoleteHandler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      available,
      obsolete,
    );
    await expect(obsoleteHandler.load(payload())).resolves.toEqual({
      state: 'canceled',
    });

    const failed = repository();
    const handler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      async () => ({
        status: 'available',
        port: {
          embed: vi.fn(async () => ({
            ...(await (
              await available()
            ).port.embed({ fragments: [], configuration: {} })),
            embeddings: [{ fragmentId: `${FRAGMENT_ID}:0`, vector: [1] }],
            dimension: 4,
          })),
        },
      }),
      failed,
    );
    const loaded = await handler.load(payload());
    if (loaded.input === undefined) throw new Error('embedding input missing');
    await expect(
      handler.execute(loaded.input, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'permanent' });
    expect(failed.markFailed).toHaveBeenCalledWith(
      FRAGMENT_ID,
      2,
      JOB_ID,
      'RangeError',
    );
  });

  it('[STATE-002][STATE-003][SEARCH-002] retries a rate-limited provider without misclassifying the canonical fragment', async () => {
    const repo = repository();
    const handler = new SearchEmbeddingJobHandler(
      {} as DatabaseClient,
      {} as PgBoss,
      async () => ({
        status: 'available',
        port: {
          embed: async () => {
            throw new AiProviderOperationError({
              code: 'provider_rate_limited',
              retryable: true,
              retryAfterMilliseconds: 5_000,
            });
          },
        },
      }),
      repo,
    );
    const loaded = await handler.load(payload());
    if (loaded.input === undefined) throw new Error('embedding input missing');

    await expect(
      handler.execute(loaded.input, new AbortController().signal),
    ).rejects.toMatchObject({ disposition: 'transient' });
    expect(repo.markFailed).toHaveBeenCalledWith(
      FRAGMENT_ID,
      2,
      JOB_ID,
      'provider_rate_limited',
    );
    expect(repo.markUnavailable).not.toHaveBeenCalled();
    expect(repo.markSucceeded).not.toHaveBeenCalled();
  });
});
