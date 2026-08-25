import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import { createUuidV7 } from '@journal/domain';

import type { JournalDatabase } from './client.js';
import { createQueueJobPayload, queueNames } from './queue-contracts.js';
import { enqueueJobInTransaction } from './queue-runtime.js';
import {
  searchEmbeddingCohorts,
  searchEmbeddingRequests,
  searchFragmentEmbeddings,
  searchFragments,
} from './schema.js';

export const SEARCH_EMBEDDING_OPERATION = 'search_embedding';
export const SEARCH_EMBEDDING_DISPATCH_OPERATION = 'search_embedding_dispatch';
export const SEARCH_EMBEDDING_DISPATCH_SCHEDULE_KEY =
  'search.embeddings.dispatch';
export const EMBEDDING_CHUNK_CHARACTERS = 2_000;
export const EMBEDDING_CHUNKS_PER_JOB = 16;
export const EMBEDDING_DISPATCH_BATCH = 50;

export interface SearchEmbeddingRequestRecord {
  readonly fragmentId: string;
  readonly ownerId: string;
  readonly generation: number;
  readonly status:
    | 'pending'
    | 'dispatched'
    | 'running'
    | 'succeeded'
    | 'unavailable'
    | 'failed';
  readonly jobId: string | null;
  readonly cohortId: string | null;
  readonly nextChunkIndex: number;
  readonly nextCharacter: number;
  readonly contentCharacters: number;
}

export interface PersistedEmbeddingCohort {
  readonly providerId: string;
  readonly providerDisplayName: string;
  readonly providerAdapterVersion?: string;
  readonly modelId: string;
  readonly modelDisplayName?: string;
  readonly modelVersion?: string;
  readonly dimension: number;
  readonly configuration: Readonly<Record<string, unknown>>;
  readonly configurationFingerprint: string;
}

export interface EmbeddingChunkRecord {
  readonly chunkIndex: number;
  readonly startCharacter: number;
  readonly endCharacter: number;
  readonly text: string;
}

/** Durable lifecycle/outbox state for identifier-only embedding jobs. */
export class SearchEmbeddingRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async dispatchPending(
    boss: PgBoss,
    createId: () => string = () => createUuidV7<'search-embedding-job'>(),
    limit = EMBEDDING_DISPATCH_BATCH,
  ): Promise<readonly string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError(
        'Embedding dispatch limit must be between 1 and 100.',
      );
    }
    return this.database.transaction(async (transaction) => {
      const pending = await transaction
        .select({
          fragmentId: searchEmbeddingRequests.fragmentId,
          generation: searchEmbeddingRequests.generation,
        })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.status, 'pending'))
        .orderBy(
          asc(searchEmbeddingRequests.requestedAt),
          asc(searchEmbeddingRequests.fragmentId),
        )
        .limit(limit)
        .for('update', { skipLocked: true });
      const jobIds: string[] = [];
      for (const request of pending) {
        const jobId = createId();
        await transaction
          .update(searchEmbeddingRequests)
          .set({ status: 'dispatched', jobId, updatedAt: new Date() })
          .where(
            and(
              eq(searchEmbeddingRequests.fragmentId, request.fragmentId),
              eq(searchEmbeddingRequests.generation, request.generation),
              eq(searchEmbeddingRequests.status, 'pending'),
            ),
          );
        await enqueueJobInTransaction({
          boss,
          transaction,
          queueName: queueNames.search,
          jobId,
          payload: createQueueJobPayload({
            queueName: queueNames.search,
            operation: SEARCH_EMBEDDING_OPERATION,
            identifiers: {
              fragmentId: request.fragmentId,
              generationKey: String(request.generation),
              requestId: request.fragmentId,
            },
          }),
        });
        jobIds.push(jobId);
      }
      return Object.freeze(jobIds);
    });
  }

  public async load(
    fragmentId: string,
  ): Promise<SearchEmbeddingRequestRecord | undefined> {
    const rows = await this.database
      .select({
        fragmentId: searchEmbeddingRequests.fragmentId,
        ownerId: searchEmbeddingRequests.ownerId,
        generation: searchEmbeddingRequests.generation,
        status: searchEmbeddingRequests.status,
        jobId: searchEmbeddingRequests.jobId,
        cohortId: searchEmbeddingRequests.cohortId,
        nextChunkIndex: searchEmbeddingRequests.nextChunkIndex,
        nextCharacter: searchEmbeddingRequests.nextCharacter,
        contentCharacters: sql<number>`char_length(${searchFragments.content})`,
      })
      .from(searchEmbeddingRequests)
      .innerJoin(
        searchFragments,
        and(
          eq(searchFragments.id, searchEmbeddingRequests.fragmentId),
          eq(searchFragments.ownerId, searchEmbeddingRequests.ownerId),
        ),
      )
      .where(eq(searchEmbeddingRequests.fragmentId, fragmentId))
      .limit(1);
    const row = rows[0];
    if (row === undefined) return undefined;
    return row as SearchEmbeddingRequestRecord;
  }

  public async markRunning(
    fragmentId: string,
    generation: number,
    jobId: string,
  ): Promise<boolean> {
    const rows = await this.database
      .update(searchEmbeddingRequests)
      .set({ status: 'running', updatedAt: new Date() })
      .where(
        and(
          eq(searchEmbeddingRequests.fragmentId, fragmentId),
          eq(searchEmbeddingRequests.generation, generation),
          eq(searchEmbeddingRequests.jobId, jobId),
          inArray(searchEmbeddingRequests.status, [
            'dispatched',
            'running',
            'failed',
          ]),
        ),
      )
      .returning({ fragmentId: searchEmbeddingRequests.fragmentId });
    return rows.length === 1;
  }

  public async readChunk(
    fragmentId: string,
    startCharacter: number,
    chunkIndex: number,
  ): Promise<EmbeddingChunkRecord | undefined> {
    const rows = await this.database
      .select({
        text: sql<string>`substring(${searchFragments.content} from ${startCharacter}::integer for ${EMBEDDING_CHUNK_CHARACTERS}::integer)`,
      })
      .from(searchFragments)
      .where(eq(searchFragments.id, fragmentId))
      .limit(1);
    const text = rows[0]?.text;
    if (text === undefined || text.length === 0) return undefined;
    return {
      text,
      chunkIndex,
      startCharacter,
      endCharacter: startCharacter + [...text].length - 1,
    };
  }

  public async persistChunk(
    input: Readonly<{
      request: SearchEmbeddingRequestRecord;
      jobId: string;
      cohort: PersistedEmbeddingCohort;
      chunk: EmbeddingChunkRecord;
      vector: readonly number[];
      createId?: () => string;
    }>,
  ): Promise<string> {
    return this.database.transaction(async (transaction) => {
      const current = await transaction
        .select({
          cohortId: searchEmbeddingRequests.cohortId,
          generation: searchEmbeddingRequests.generation,
          jobId: searchEmbeddingRequests.jobId,
          status: searchEmbeddingRequests.status,
        })
        .from(searchEmbeddingRequests)
        .where(eq(searchEmbeddingRequests.fragmentId, input.request.fragmentId))
        .for('update')
        .limit(1);
      const request = current[0];
      if (
        request === undefined ||
        request.generation !== input.request.generation ||
        request.jobId !== input.jobId ||
        request.status !== 'running'
      ) {
        throw new Error('Embedding request is no longer current.');
      }
      await transaction
        .insert(searchEmbeddingCohorts)
        .values({
          id: input.createId?.() ?? createUuidV7<'search-embedding-cohort'>(),
          ownerId: input.request.ownerId,
          providerId: input.cohort.providerId,
          providerDisplayName: input.cohort.providerDisplayName,
          providerAdapterVersion: input.cohort.providerAdapterVersion,
          modelId: input.cohort.modelId,
          modelDisplayName: input.cohort.modelDisplayName,
          modelVersion: input.cohort.modelVersion ?? '',
          dimension: input.cohort.dimension,
          configuration: input.cohort.configuration,
          configurationFingerprint: input.cohort.configurationFingerprint,
        })
        .onConflictDoNothing();
      const cohorts = await transaction
        .select({ id: searchEmbeddingCohorts.id })
        .from(searchEmbeddingCohorts)
        .where(
          and(
            eq(searchEmbeddingCohorts.ownerId, input.request.ownerId),
            eq(searchEmbeddingCohorts.providerId, input.cohort.providerId),
            eq(searchEmbeddingCohorts.modelId, input.cohort.modelId),
            eq(
              searchEmbeddingCohorts.modelVersion,
              input.cohort.modelVersion ?? '',
            ),
            eq(searchEmbeddingCohorts.dimension, input.cohort.dimension),
            eq(
              searchEmbeddingCohorts.configurationFingerprint,
              input.cohort.configurationFingerprint,
            ),
          ),
        )
        .limit(1);
      const cohortId = cohorts[0]?.id;
      if (cohortId === undefined)
        throw new Error('Embedding cohort was not persisted.');
      if (request.cohortId !== null && request.cohortId !== cohortId) {
        throw new Error(
          'Embedding provider cohort changed during one reindex request.',
        );
      }
      if (request.cohortId === null && input.chunk.chunkIndex === 0) {
        await transaction
          .delete(searchFragmentEmbeddings)
          .where(
            and(
              eq(searchFragmentEmbeddings.fragmentId, input.request.fragmentId),
              eq(searchFragmentEmbeddings.cohortId, cohortId),
            ),
          );
      }
      await transaction
        .insert(searchFragmentEmbeddings)
        .values({
          fragmentId: input.request.fragmentId,
          cohortId,
          ownerId: input.request.ownerId,
          chunkIndex: input.chunk.chunkIndex,
          startCharacter: input.chunk.startCharacter,
          endCharacter: input.chunk.endCharacter,
          embedding: input.vector,
        })
        .onConflictDoUpdate({
          target: [
            searchFragmentEmbeddings.fragmentId,
            searchFragmentEmbeddings.cohortId,
            searchFragmentEmbeddings.chunkIndex,
          ],
          set: {
            startCharacter: input.chunk.startCharacter,
            endCharacter: input.chunk.endCharacter,
            embedding: input.vector,
            indexedAt: new Date(),
          },
        });
      await transaction
        .update(searchEmbeddingRequests)
        .set({
          cohortId,
          nextChunkIndex: input.chunk.chunkIndex + 1,
          nextCharacter: input.chunk.endCharacter + 1,
          updatedAt: new Date(),
        })
        .where(
          eq(searchEmbeddingRequests.fragmentId, input.request.fragmentId),
        );
      return cohortId;
    });
  }

  public async markSucceeded(
    fragmentId: string,
    generation: number,
    jobId: string,
  ): Promise<void> {
    await this.finish(fragmentId, generation, jobId, {
      status: 'succeeded',
      completedAt: new Date(),
    });
  }

  public async markPendingContinuation(
    fragmentId: string,
    generation: number,
    jobId: string,
  ): Promise<void> {
    await this.finish(fragmentId, generation, jobId, { status: 'pending' });
  }

  public async markUnavailable(
    fragmentId: string,
    generation: number,
    jobId: string,
    reason: string,
  ): Promise<void> {
    await this.finish(fragmentId, generation, jobId, {
      status: 'unavailable',
      lastErrorCode: reason.slice(0, 120),
    });
  }

  public async markFailed(
    fragmentId: string,
    generation: number,
    jobId: string,
    errorCode: string,
  ): Promise<void> {
    await this.database
      .update(searchEmbeddingRequests)
      .set({
        status: 'failed',
        lastErrorCode: errorCode.slice(0, 120),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(searchEmbeddingRequests.fragmentId, fragmentId),
          eq(searchEmbeddingRequests.generation, generation),
          eq(searchEmbeddingRequests.jobId, jobId),
        ),
      );
  }

  public async requestOwnerReindex(ownerId: string): Promise<number> {
    const rows = await this.database
      .update(searchEmbeddingRequests)
      .set({
        generation: sql`${searchEmbeddingRequests.generation} + 1`,
        status: 'pending',
        jobId: null,
        cohortId: null,
        nextChunkIndex: 0,
        nextCharacter: 1,
        lastErrorCode: null,
        requestedAt: new Date(),
        updatedAt: new Date(),
        completedAt: null,
      })
      .where(eq(searchEmbeddingRequests.ownerId, ownerId))
      .returning({ fragmentId: searchEmbeddingRequests.fragmentId });
    return rows.length;
  }

  private async finish(
    fragmentId: string,
    generation: number,
    jobId: string,
    state: Readonly<{
      status: 'pending' | 'succeeded' | 'unavailable';
      lastErrorCode?: string;
      completedAt?: Date;
    }>,
  ): Promise<void> {
    await this.database
      .update(searchEmbeddingRequests)
      .set({
        status: state.status,
        jobId: null,
        lastErrorCode: state.lastErrorCode ?? null,
        completedAt: state.completedAt ?? null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(searchEmbeddingRequests.fragmentId, fragmentId),
          eq(searchEmbeddingRequests.generation, generation),
          eq(searchEmbeddingRequests.jobId, jobId),
        ),
      );
  }
}
