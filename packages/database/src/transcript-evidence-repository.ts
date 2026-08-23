import { createHash } from 'node:crypto';

import {
  EVIDENCE_NORMALIZATION,
  EVIDENCE_OFFSET_UNIT,
  audioEvidenceRange,
  locateTranscriptSegments,
  normalizeEvidenceText,
  textEvidenceCoordinates,
} from '@journal/domain';
import { and, eq, inArray, sql } from 'drizzle-orm';

import type { JournalTransaction, RepositoryContext } from './client.js';
import {
  transcriptCleanupRuns,
  transcriptEvidenceSpans,
  transcriptRevisions,
  transcriptSegments,
} from './schema.js';

export type TranscriptSegmentRecord = typeof transcriptSegments.$inferSelect;
export type TranscriptEvidenceSpanRecord =
  typeof transcriptEvidenceSpans.$inferSelect;

export type PersistableTranscriptSegment = Readonly<{
  id: string;
  sourceSegmentId?: string;
  text: string;
  timing:
    | Readonly<{ status: 'known'; startMs: number; endMs: number }>
    | Readonly<{ status: 'unknown' }>;
  providerMetadata?: Readonly<Record<string, unknown>>;
}>;

export class TranscriptEvidenceStateError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'TranscriptEvidenceStateError';
  }
}

export function evidenceQuoteHash(quote: string): string {
  return createHash('sha256').update(quote).digest('hex');
}

export async function persistTranscriptSegments(input: {
  readonly transaction: JournalTransaction;
  readonly transcriptRevisionId: string;
  readonly evidenceText: string;
  readonly segments: readonly PersistableTranscriptSegment[];
  readonly createdAt: Date;
}): Promise<readonly TranscriptSegmentRecord[]> {
  if (input.segments.length === 0) return [];
  const located = locateTranscriptSegments({
    evidenceText: input.evidenceText,
    segments: input.segments.map((segment) => ({
      id: segment.id,
      text: segment.text,
      ...(segment.timing.status === 'unknown'
        ? {}
        : {
            audioRange: {
              startMs: segment.timing.startMs,
              endMs: segment.timing.endMs,
            },
          }),
    })),
  });
  return input.transaction
    .insert(transcriptSegments)
    .values(
      located.map((segment, index) => {
        const source = input.segments[index];
        if (source === undefined) {
          throw new TranscriptEvidenceStateError(
            'Located transcript segment lost its source metadata.',
          );
        }
        return {
          id: segment.id,
          transcriptRevisionId: input.transcriptRevisionId,
          ...(source.sourceSegmentId === undefined
            ? {}
            : { sourceSegmentId: source.sourceSegmentId }),
          ordinal: segment.ordinal,
          startUtf16: segment.startUtf16,
          endUtf16: segment.endUtf16,
          ...(segment.audioRange === undefined
            ? {}
            : {
                startMs: BigInt(segment.audioRange.startMs),
                endMs: BigInt(segment.audioRange.endMs),
              }),
          quote: segment.quote,
          quoteHash: evidenceQuoteHash(segment.quote),
          ...(source.providerMetadata === undefined
            ? {}
            : { providerMetadata: source.providerMetadata }),
          createdAt: input.createdAt,
        };
      }),
    )
    .returning();
}

export type TranscriptInvalidationResult = Readonly<{
  staleRevisionIds: readonly string[];
  staleCleanupRunIds: readonly string[];
}>;

/** Marks only revisions transitively derived from the superseded exact input. */
export async function invalidateTranscriptRevisionDependents(input: {
  readonly transaction: JournalTransaction;
  readonly sourceRevisionId: string;
  readonly now: Date;
}): Promise<TranscriptInvalidationResult> {
  const staleRevisions = await input.transaction.execute<{ id: string }>(sql`
    with recursive downstream(id) as (
      select ${transcriptRevisions.id}
      from ${transcriptRevisions}
      where ${transcriptRevisions.sourceRevisionId} = ${input.sourceRevisionId}
      union
      select child.id
      from ${transcriptRevisions} child
      inner join downstream parent on child.source_revision_id = parent.id
    ), stale as (
      update ${transcriptRevisions}
      set stale_at = ${input.now}, stale_reason = 'source_revision_superseded'
      where id in (select id from downstream) and stale_at is null
      returning id
    )
    select id from stale order by id
  `);
  const staleRevisionIds = staleRevisions.rows.map(({ id }) => id);

  const staleCleanupRuns = await input.transaction
    .update(transcriptCleanupRuns)
    .set({
      status: sql`case when ${transcriptCleanupRuns.status} = 'succeeded' then ${transcriptCleanupRuns.status} else 'canceled'::transcription_run_status end`,
      staleAt: sql`case when ${transcriptCleanupRuns.status} = 'succeeded' then ${input.now}::timestamptz else null end`,
      staleReason: sql`case when ${transcriptCleanupRuns.status} = 'succeeded' then 'source_revision_superseded' else null end`,
      completedAt: input.now,
      updatedAt: input.now,
    })
    .where(
      and(
        eq(
          transcriptCleanupRuns.sourceCorrectedRevisionId,
          input.sourceRevisionId,
        ),
        inArray(transcriptCleanupRuns.status, [
          'queued',
          'running',
          'succeeded',
        ]),
      ),
    )
    .returning({ id: transcriptCleanupRuns.id });

  if (staleRevisionIds.length > 0) {
    await input.transaction
      .update(transcriptEvidenceSpans)
      .set({
        resolutionStatus: 'stale',
        unresolvedReason: 'source_revision_superseded',
        updatedAt: input.now,
      })
      .where(
        inArray(
          transcriptEvidenceSpans.dependentTranscriptRevisionId,
          staleRevisionIds,
        ),
      );
  }
  return Object.freeze({
    staleRevisionIds: Object.freeze(staleRevisionIds),
    staleCleanupRunIds: Object.freeze(staleCleanupRuns.map(({ id }) => id)),
  });
}

export class TranscriptEvidenceRepository {
  public constructor(private readonly context: RepositoryContext) {}

  public async listSegments(
    transcriptRevisionId: string,
  ): Promise<readonly TranscriptSegmentRecord[]> {
    return this.context
      .select()
      .from(transcriptSegments)
      .where(eq(transcriptSegments.transcriptRevisionId, transcriptRevisionId))
      .orderBy(transcriptSegments.ordinal);
  }

  public async createSpan(input: {
    readonly id: string;
    readonly dependentTranscriptRevisionId: string;
    readonly sourceTranscriptRevisionId: string;
    readonly sourceSegmentId?: string;
    readonly startUtf16: number;
    readonly endUtf16: number;
    readonly audioRange?: Readonly<{ startMs: number; endMs: number }>;
    readonly now?: Date;
  }): Promise<TranscriptEvidenceSpanRecord> {
    const [sourceRevision] = await this.context
      .select({ evidenceText: transcriptRevisions.evidenceText })
      .from(transcriptRevisions)
      .where(eq(transcriptRevisions.id, input.sourceTranscriptRevisionId))
      .limit(1);
    if (sourceRevision === undefined) {
      throw new TranscriptEvidenceStateError(
        'Evidence source revision does not exist.',
      );
    }
    if (input.sourceSegmentId !== undefined) {
      const [segment] = await this.context
        .select({ id: transcriptSegments.id })
        .from(transcriptSegments)
        .where(
          and(
            eq(transcriptSegments.id, input.sourceSegmentId),
            eq(
              transcriptSegments.transcriptRevisionId,
              input.sourceTranscriptRevisionId,
            ),
          ),
        )
        .limit(1);
      if (segment === undefined) {
        throw new TranscriptEvidenceStateError(
          'Evidence segment does not belong to the exact source revision.',
        );
      }
    }
    const coordinates = textEvidenceCoordinates({
      evidenceText: sourceRevision.evidenceText,
      startUtf16: input.startUtf16,
      endUtf16: input.endUtf16,
    });
    const range =
      input.audioRange === undefined
        ? undefined
        : audioEvidenceRange(input.audioRange.startMs, input.audioRange.endMs);
    const [span] = await this.context
      .insert(transcriptEvidenceSpans)
      .values({
        id: input.id,
        dependentTranscriptRevisionId: input.dependentTranscriptRevisionId,
        sourceTranscriptRevisionId: input.sourceTranscriptRevisionId,
        ...(input.sourceSegmentId === undefined
          ? {}
          : { sourceSegmentId: input.sourceSegmentId }),
        normalization: coordinates.normalization,
        offsetUnit: coordinates.offsetUnit,
        startUtf16: coordinates.startUtf16,
        endUtf16: coordinates.endUtf16,
        ...(range === undefined
          ? {}
          : { startMs: BigInt(range.startMs), endMs: BigInt(range.endMs) }),
        quote: coordinates.quote,
        quoteHash: evidenceQuoteHash(coordinates.quote),
        resolutionStatus: 'resolved',
        createdAt: input.now,
        updatedAt: input.now,
      })
      .returning();
    if (span === undefined) {
      throw new TranscriptEvidenceStateError('Evidence span was not created.');
    }
    return span;
  }

  public async setUnresolved(
    evidenceSpanId: string,
    reason: string,
    now: Date,
  ): Promise<TranscriptEvidenceSpanRecord> {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(reason)) {
      throw new TranscriptEvidenceStateError(
        'Unresolved evidence requires a stable content-free reason code.',
      );
    }
    const [span] = await this.context
      .update(transcriptEvidenceSpans)
      .set({
        resolutionStatus: 'unresolved',
        unresolvedReason: reason,
        updatedAt: now,
      })
      .where(eq(transcriptEvidenceSpans.id, evidenceSpanId))
      .returning();
    if (span === undefined) {
      throw new TranscriptEvidenceStateError('Evidence span does not exist.');
    }
    return span;
  }

  public async verifySpan(
    evidenceSpanId: string,
    now: Date,
  ): Promise<TranscriptEvidenceSpanRecord> {
    const [row] = await this.context
      .select({
        span: transcriptEvidenceSpans,
        evidenceText: transcriptRevisions.evidenceText,
      })
      .from(transcriptEvidenceSpans)
      .innerJoin(
        transcriptRevisions,
        eq(
          transcriptRevisions.id,
          transcriptEvidenceSpans.sourceTranscriptRevisionId,
        ),
      )
      .where(eq(transcriptEvidenceSpans.id, evidenceSpanId))
      .limit(1);
    if (row === undefined) {
      throw new TranscriptEvidenceStateError('Evidence span does not exist.');
    }
    let valid: boolean;
    try {
      const coordinates = textEvidenceCoordinates({
        evidenceText: row.evidenceText,
        startUtf16: row.span.startUtf16,
        endUtf16: row.span.endUtf16,
      });
      valid =
        row.span.normalization === EVIDENCE_NORMALIZATION &&
        row.span.offsetUnit === EVIDENCE_OFFSET_UNIT &&
        row.span.quote === coordinates.quote &&
        row.span.quoteHash === evidenceQuoteHash(coordinates.quote);
    } catch {
      valid = false;
    }
    if (valid || row.span.resolutionStatus === 'stale') return row.span;
    return this.setUnresolved(evidenceSpanId, 'quote_or_offset_mismatch', now);
  }

  public async listSpansForDependent(
    dependentTranscriptRevisionId: string,
  ): Promise<readonly TranscriptEvidenceSpanRecord[]> {
    return this.context
      .select()
      .from(transcriptEvidenceSpans)
      .where(
        eq(
          transcriptEvidenceSpans.dependentTranscriptRevisionId,
          dependentTranscriptRevisionId,
        ),
      )
      .orderBy(transcriptEvidenceSpans.createdAt, transcriptEvidenceSpans.id);
  }
}

export function canonicalTranscriptEvidenceText(text: string): string {
  return normalizeEvidenceText(text);
}
