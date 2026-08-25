import { createHash } from 'node:crypto';

import { and, asc, eq, inArray } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type {
  GroundedAnswerRequest,
  SearchRetrievalMetadata,
} from '@journal/contracts';
import {
  GROUNDED_ANSWER_PROMPT,
  MAX_GROUNDED_ANSWER_FRAGMENTS,
  boundedGroundingFragments,
  createUuidV7,
  searchResultHref,
} from '@journal/domain';

import type { JournalDatabase } from './client.js';
import { createQueueJobPayload, queueNames } from './queue-contracts.js';
import { enqueueJobInTransaction } from './queue-runtime.js';
import {
  groundedAnswerCitations,
  groundedAnswers,
  searchFragments,
} from './schema.js';

export const GROUNDED_ANSWER_OPERATION = 'grounded_answer';
export const GROUNDED_ANSWER_CONFIGURATION = Object.freeze({
  temperature: 0,
  maxOutputCharacters: 8_000,
});

export class GroundedAnswerIdempotencyConflictError extends Error {
  public constructor() {
    super('The idempotency key was already used for a different question.');
    this.name = 'GroundedAnswerIdempotencyConflictError';
  }
}

export interface GroundedAnswerCandidateRecord {
  readonly citationId: string;
  readonly suppliedOrdinal: number;
  readonly citedOrdinal: number | null;
  readonly fragmentId: string;
  readonly sourceKind: string;
  readonly layer: string;
  readonly sourceId: string;
  readonly sourceRevisionId: string;
  readonly sourceRevision: number;
  readonly journalDate: string | null;
  readonly authority: 'manual' | 'generated';
  readonly retrievedQuote: string;
  readonly normalization: string;
  readonly offsetUnit: string;
  readonly startUtf16: number;
  readonly endUtf16: number;
  readonly quoteSha256: string;
  readonly href: string;
}

export interface GroundedAnswerRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly question: string;
  readonly request: Readonly<Record<string, unknown>>;
  readonly requestHash: string;
  readonly retrieval: SearchRetrievalMetadata;
  readonly status:
    'queued' | 'running' | 'succeeded' | 'insufficient_support' | 'failed';
  readonly jobId: string | null;
  readonly synthesis: string | null;
  readonly failureCode: string | null;
  readonly promptId: string;
  readonly promptVersion: string;
  readonly promptTemplateHash: string;
  readonly requestedConfiguration: Readonly<Record<string, unknown>>;
  readonly effectiveMessagesHash: string | null;
  readonly provider: Readonly<Record<string, unknown>> | null;
  readonly model: Readonly<Record<string, unknown>> | null;
  readonly effectiveConfiguration: Readonly<Record<string, unknown>> | null;
  readonly usage: Readonly<Record<string, unknown>> | null;
  readonly processingTimeMilliseconds: bigint | null;
  readonly rawResponseId: string | null;
  readonly rawResponseMediaType: string | null;
  readonly rawResponseByteSize: bigint | null;
  readonly rawResponseSha256: string | null;
  readonly rawResponseRetention: string | null;
  readonly rawResponseExpiresAt: Date | null;
  readonly requestedAt: Date;
  readonly completedAt: Date | null;
  readonly citations: readonly GroundedAnswerCandidateRecord[];
  readonly allCitationsCurrent: boolean;
}

export interface CanonicalGroundedAnswerInput {
  readonly answer: GroundedAnswerRecord;
  readonly citations: readonly GroundedAnswerCandidateRecord[];
}

interface GroundedAnswerCompletion {
  readonly answerId: string;
  readonly status: 'succeeded' | 'insufficient_support';
  readonly synthesis?: string;
  readonly citationIds: readonly string[];
  readonly effectiveMessagesHash: string;
  readonly provider: Readonly<Record<string, unknown>>;
  readonly model: Readonly<Record<string, unknown>>;
  readonly effectiveConfiguration: Readonly<Record<string, unknown>>;
  readonly usage: Readonly<Record<string, unknown>>;
  readonly processingTimeMilliseconds: bigint;
  readonly rawResponse: Readonly<{
    id: string;
    blobKey: string;
    mediaType: string;
    byteSize: bigint;
    sha256: string;
    providerRequestId?: string;
    retention: string;
    expiresAt: Date;
  }>;
  readonly now: Date;
}

function opaqueCitationId(createId: () => string): string {
  return `cite_${createId().replaceAll('-', '')}`;
}

export class GroundedAnswerRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async create(input: {
    readonly boss: PgBoss;
    readonly ownerId: string;
    readonly request: GroundedAnswerRequest;
    readonly requestHash: string;
    readonly idempotencyKey: string;
    readonly retrieval: SearchRetrievalMetadata;
    readonly fragmentIds: readonly string[];
    readonly createId?: () => string;
    readonly now?: Date;
  }): Promise<Readonly<{ answerId: string; created: boolean }>> {
    const createId =
      input.createId ?? (() => createUuidV7<'grounded-answer'>());
    const now = input.now ?? new Date();
    return this.database.transaction(async (transaction) => {
      const [existing] = await transaction
        .select({
          id: groundedAnswers.id,
          requestHash: groundedAnswers.requestHash,
        })
        .from(groundedAnswers)
        .where(
          and(
            eq(groundedAnswers.ownerId, input.ownerId),
            eq(groundedAnswers.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing !== undefined) {
        if (existing.requestHash !== input.requestHash)
          throw new GroundedAnswerIdempotencyConflictError();
        return { answerId: existing.id, created: false };
      }

      const uniqueFragmentIds = [
        ...new Set(input.fragmentIds.slice(0, MAX_GROUNDED_ANSWER_FRAGMENTS)),
      ];
      const rows =
        uniqueFragmentIds.length === 0
          ? []
          : await transaction
              .select({
                fragmentId: searchFragments.id,
                sourceKind: searchFragments.sourceKind,
                layer: searchFragments.layer,
                sourceId: searchFragments.sourceId,
                sourceRevisionId: searchFragments.sourceRevisionId,
                sourceRevision: searchFragments.sourceRevision,
                journalDate: searchFragments.journalDate,
                authority: searchFragments.authority,
                content: searchFragments.content,
                memoryId: searchFragments.memoryId,
              })
              .from(searchFragments)
              .where(
                and(
                  eq(searchFragments.ownerId, input.ownerId),
                  inArray(searchFragments.id, uniqueFragmentIds),
                ),
              );
      const byId = new Map(rows.map((row) => [row.fragmentId, row]));
      const generatedCandidates = uniqueFragmentIds.flatMap((fragmentId) => {
        const row = byId.get(fragmentId);
        return row === undefined
          ? []
          : [
              {
                citationId: opaqueCitationId(createId),
                layer: row.layer,
                sourceRevisionId: row.sourceRevisionId,
                ...(row.journalDate === null
                  ? {}
                  : { journalDate: row.journalDate }),
                text: row.content,
              },
            ];
      });
      const candidates = boundedGroundingFragments(generatedCandidates);
      const rowByCitationId = new Map(
        generatedCandidates.map((candidate) => [
          candidate.citationId,
          rows.find(
            ({ sourceRevisionId }) =>
              sourceRevisionId === candidate.sourceRevisionId,
          ),
        ]),
      );
      const answerId = createId();
      const jobId = candidates.length === 0 ? null : createId();
      await transaction.insert(groundedAnswers).values({
        id: answerId,
        ownerId: input.ownerId,
        question: input.request.question,
        request: input.request,
        requestHash: input.requestHash,
        idempotencyKey: input.idempotencyKey,
        retrieval: input.retrieval,
        status: candidates.length === 0 ? 'insufficient_support' : 'queued',
        jobId,
        promptId: GROUNDED_ANSWER_PROMPT.id,
        promptVersion: GROUNDED_ANSWER_PROMPT.version,
        promptTemplateHash: GROUNDED_ANSWER_PROMPT.templateHash,
        requestedConfiguration: GROUNDED_ANSWER_CONFIGURATION,
        requestedAt: now,
        completedAt: candidates.length === 0 ? now : null,
      });
      if (candidates.length > 0) {
        await transaction.insert(groundedAnswerCitations).values(
          candidates.map((candidate, suppliedOrdinal) => {
            const row = rowByCitationId.get(candidate.citationId);
            if (row === undefined)
              throw new Error('Grounding fragment disappeared.');
            return {
              answerId,
              citationId: candidate.citationId,
              suppliedOrdinal,
              citedOrdinal: null,
              fragmentId: row.fragmentId,
              sourceKind: row.sourceKind,
              layer: row.layer,
              sourceId: row.sourceId,
              sourceRevisionId: row.sourceRevisionId,
              sourceRevision: row.sourceRevision,
              journalDate: row.journalDate,
              authority: row.authority,
              retrievedQuote: candidate.text,
              normalization: 'NFC_LF_V1',
              offsetUnit: 'utf16_code_unit',
              startUtf16: 0,
              endUtf16: candidate.text.length,
              quoteSha256: createHash('sha256')
                .update(candidate.text)
                .digest('hex'),
              href: `${searchResultHref({
                ...(row.journalDate === null
                  ? {}
                  : { journalDate: row.journalDate }),
                sourceRevisionId: row.sourceRevisionId,
                sourceKind: row.sourceKind,
                ...(row.memoryId === null ? {} : { memoryId: row.memoryId }),
              })}&startUtf16=0&endUtf16=${String(candidate.text.length)}`,
            };
          }),
        );
        await enqueueJobInTransaction({
          boss: input.boss,
          transaction,
          queueName: queueNames.groundedAnswers,
          jobId: jobId as string,
          payload: createQueueJobPayload({
            queueName: queueNames.groundedAnswers,
            operation: GROUNDED_ANSWER_OPERATION,
            identifiers: { answerId, ownerId: input.ownerId },
          }),
        });
      }
      return { answerId, created: true };
    });
  }

  public async loadForOwner(
    answerId: string,
    ownerId: string,
  ): Promise<GroundedAnswerRecord | undefined> {
    return this.load(answerId, ownerId);
  }

  public async loadCanonical(
    answerId: string,
  ): Promise<CanonicalGroundedAnswerInput | undefined> {
    const answer = await this.load(answerId);
    if (answer === undefined) return undefined;
    return {
      answer,
      citations: answer.allCitationsCurrent ? answer.citations : [],
    };
  }

  public async markRunning(
    answerId: string,
    jobId: string,
    now: Date,
  ): Promise<boolean> {
    const rows = await this.database
      .update(groundedAnswers)
      .set({
        status: 'running',
        startedAt: now,
        completedAt: null,
        failureCode: null,
      })
      .where(
        and(
          eq(groundedAnswers.id, answerId),
          eq(groundedAnswers.jobId, jobId),
          inArray(groundedAnswers.status, ['queued', 'running', 'failed']),
        ),
      )
      .returning({ id: groundedAnswers.id });
    return rows.length === 1;
  }

  public async complete(input: GroundedAnswerCompletion): Promise<void> {
    await this.database.transaction(async (transaction) => {
      const supplied = await transaction
        .select({ fragmentId: groundedAnswerCitations.fragmentId })
        .from(groundedAnswerCitations)
        .where(eq(groundedAnswerCitations.answerId, input.answerId));
      const current =
        supplied.length === 0
          ? []
          : await transaction
              .select({ id: searchFragments.id })
              .from(searchFragments)
              .where(
                inArray(
                  searchFragments.id,
                  supplied.map(({ fragmentId }) => fragmentId),
                ),
              )
              .for('update');
      if (current.length !== supplied.length) {
        await transaction
          .update(groundedAnswers)
          .set({
            status: 'insufficient_support',
            synthesis: null,
            failureCode: null,
            effectiveMessagesHash: input.effectiveMessagesHash,
            provider: input.provider,
            model: input.model,
            effectiveConfiguration: input.effectiveConfiguration,
            usage: input.usage,
            processingTimeMilliseconds: input.processingTimeMilliseconds,
            rawResponseId: input.rawResponse.id,
            rawResponseBlobKey: input.rawResponse.blobKey,
            rawResponseMediaType: input.rawResponse.mediaType,
            rawResponseByteSize: input.rawResponse.byteSize,
            rawResponseSha256: input.rawResponse.sha256,
            rawResponseProviderRequestId:
              input.rawResponse.providerRequestId ?? null,
            rawResponseRetention: input.rawResponse.retention,
            rawResponseExpiresAt: input.rawResponse.expiresAt,
            completedAt: input.now,
          })
          .where(eq(groundedAnswers.id, input.answerId));
        return;
      }
      await transaction
        .update(groundedAnswerCitations)
        .set({ citedOrdinal: null })
        .where(eq(groundedAnswerCitations.answerId, input.answerId));
      for (const [citedOrdinal, citationId] of input.citationIds.entries()) {
        await transaction
          .update(groundedAnswerCitations)
          .set({ citedOrdinal })
          .where(
            and(
              eq(groundedAnswerCitations.answerId, input.answerId),
              eq(groundedAnswerCitations.citationId, citationId),
            ),
          );
      }
      await transaction
        .update(groundedAnswers)
        .set({
          status: input.status,
          synthesis: input.synthesis ?? null,
          failureCode: null,
          effectiveMessagesHash: input.effectiveMessagesHash,
          provider: input.provider,
          model: input.model,
          effectiveConfiguration: input.effectiveConfiguration,
          usage: input.usage,
          processingTimeMilliseconds: input.processingTimeMilliseconds,
          rawResponseId: input.rawResponse.id,
          rawResponseBlobKey: input.rawResponse.blobKey,
          rawResponseMediaType: input.rawResponse.mediaType,
          rawResponseByteSize: input.rawResponse.byteSize,
          rawResponseSha256: input.rawResponse.sha256,
          rawResponseProviderRequestId:
            input.rawResponse.providerRequestId ?? null,
          rawResponseRetention: input.rawResponse.retention,
          rawResponseExpiresAt: input.rawResponse.expiresAt,
          completedAt: input.now,
        })
        .where(eq(groundedAnswers.id, input.answerId));
    });
  }

  public async markFailed(
    answerId: string,
    code: string,
    now: Date,
  ): Promise<void> {
    await this.database
      .update(groundedAnswers)
      .set({
        status: 'failed',
        synthesis: null,
        failureCode: code.slice(0, 120),
        completedAt: now,
      })
      .where(eq(groundedAnswers.id, answerId));
  }

  public async markInsufficient(answerId: string, now: Date): Promise<void> {
    await this.database
      .update(groundedAnswers)
      .set({
        status: 'insufficient_support',
        synthesis: null,
        failureCode: null,
        completedAt: now,
      })
      .where(eq(groundedAnswers.id, answerId));
  }

  private async load(
    answerId: string,
    ownerId?: string,
  ): Promise<GroundedAnswerRecord | undefined> {
    const [answer] = await this.database
      .select()
      .from(groundedAnswers)
      .where(
        ownerId === undefined
          ? eq(groundedAnswers.id, answerId)
          : and(
              eq(groundedAnswers.id, answerId),
              eq(groundedAnswers.ownerId, ownerId),
            ),
      )
      .limit(1);
    if (answer === undefined) return undefined;
    const citations = await this.database
      .select()
      .from(groundedAnswerCitations)
      .where(eq(groundedAnswerCitations.answerId, answerId))
      .orderBy(asc(groundedAnswerCitations.suppliedOrdinal));
    const current =
      citations.length === 0
        ? []
        : await this.database
            .select({
              id: searchFragments.id,
              sourceRevisionId: searchFragments.sourceRevisionId,
            })
            .from(searchFragments)
            .where(
              and(
                eq(searchFragments.ownerId, answer.ownerId),
                inArray(
                  searchFragments.id,
                  citations.map(({ fragmentId }) => fragmentId),
                ),
              ),
            );
    const currentById = new Map(
      current.map((row) => [row.id, row.sourceRevisionId]),
    );
    return {
      ...answer,
      retrieval: answer.retrieval as SearchRetrievalMetadata,
      status: answer.status,
      citations,
      allCitationsCurrent: citations.every(
        (citation) =>
          currentById.get(citation.fragmentId) === citation.sourceRevisionId,
      ),
    } as GroundedAnswerRecord;
  }
}
