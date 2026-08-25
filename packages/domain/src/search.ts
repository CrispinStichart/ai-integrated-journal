export interface SearchSnippetSegment {
  readonly text: string;
  readonly highlighted: boolean;
}

export const RECIPROCAL_RANK_FUSION_K = 60;
export const MAX_RETRIEVAL_CANDIDATES = 200;

export interface RankedRetrievalCandidate {
  readonly fragmentId: string;
  readonly score: number;
  readonly lexicalRank?: number;
  readonly semanticRank?: number;
}

function uniqueRanks(
  fragmentIds: readonly string[],
): ReadonlyMap<string, number> {
  const ranks = new Map<string, number>();
  for (const fragmentId of fragmentIds.slice(0, MAX_RETRIEVAL_CANDIDATES)) {
    if (!ranks.has(fragmentId)) ranks.set(fragmentId, ranks.size + 1);
  }
  return ranks;
}

/**
 * Provider-neutral reciprocal-rank fusion. Scores depend only on each input
 * ordering; callers apply stable source metadata as the final tie-breaker.
 */
export function reciprocalRankFusion(
  lexicalFragmentIds: readonly string[],
  semanticFragmentIds: readonly string[],
  k = RECIPROCAL_RANK_FUSION_K,
): readonly RankedRetrievalCandidate[] {
  if (!Number.isSafeInteger(k) || k < 1) {
    throw new RangeError(
      'Reciprocal-rank fusion k must be a positive integer.',
    );
  }
  const lexicalRanks = uniqueRanks(lexicalFragmentIds);
  const semanticRanks = uniqueRanks(semanticFragmentIds);
  const fragmentIds = new Set([
    ...lexicalRanks.keys(),
    ...semanticRanks.keys(),
  ]);
  return Object.freeze(
    [...fragmentIds]
      .map((fragmentId): RankedRetrievalCandidate => {
        const lexicalRank = lexicalRanks.get(fragmentId);
        const semanticRank = semanticRanks.get(fragmentId);
        return {
          fragmentId,
          score:
            (lexicalRank === undefined ? 0 : 1 / (k + lexicalRank)) +
            (semanticRank === undefined ? 0 : 1 / (k + semanticRank)),
          ...(lexicalRank === undefined ? {} : { lexicalRank }),
          ...(semanticRank === undefined ? {} : { semanticRank }),
        };
      })
      .sort(
        (left, right) =>
          right.score - left.score ||
          left.fragmentId.localeCompare(right.fragmentId),
      ),
  );
}

export interface EmbeddingCohortIdentity {
  readonly providerId: string;
  readonly modelId: string;
  readonly modelVersion?: string;
  readonly dimension: number;
  readonly configurationFingerprint: string;
}

/** Exact identity required before vectors may be compared or fused. */
export function embeddingCohortKey(cohort: EmbeddingCohortIdentity): string {
  if (!cohort.providerId || !cohort.modelId) {
    throw new RangeError(
      'Embedding cohort provider and model IDs are required.',
    );
  }
  if (
    !Number.isSafeInteger(cohort.dimension) ||
    cohort.dimension < 1 ||
    cohort.dimension > 4096
  ) {
    throw new RangeError(
      'Embedding cohort dimension must be between 1 and 4096.',
    );
  }
  if (!/^[0-9a-f]{64}$/u.test(cohort.configurationFingerprint)) {
    throw new RangeError(
      'Embedding cohort configuration fingerprint must be SHA-256.',
    );
  }
  return JSON.stringify([
    cohort.providerId,
    cohort.modelId,
    cohort.modelVersion ?? '',
    cohort.dimension,
    cohort.configurationFingerprint,
  ]);
}

/** Rejects malformed provider vectors before persistence or comparison. */
export function validateEmbeddingVector(
  vector: readonly number[],
  dimension: number,
): readonly number[] {
  if (vector.length !== dimension || dimension < 1 || dimension > 4096) {
    throw new RangeError(
      'Embedding vector does not match its bounded dimension.',
    );
  }
  if (vector.some((value) => !Number.isFinite(value))) {
    throw new RangeError('Embedding vectors must contain only finite numbers.');
  }
  return Object.freeze([...vector]);
}

/**
 * Converts PostgreSQL ts_headline sentinels into inert text segments. Callers
 * render each segment as text; journal content is never interpreted as HTML.
 */
export function parseSearchHeadline(
  headline: string,
  startMarker = '\uE000',
  endMarker = '\uE001',
): readonly SearchSnippetSegment[] {
  const result: SearchSnippetSegment[] = [];
  let highlighted = false;
  let offset = 0;
  for (let index = 0; index < headline.length; index += 1) {
    const marker = headline[index];
    if (marker !== startMarker && marker !== endMarker) continue;
    if (index > offset)
      result.push({ text: headline.slice(offset, index), highlighted });
    highlighted = marker === startMarker;
    offset = index + 1;
  }
  if (offset < headline.length)
    result.push({ text: headline.slice(offset), highlighted });
  return result.length > 0
    ? Object.freeze(result)
    : Object.freeze([{ text: headline, highlighted: false }]);
}

export function searchResultHref(
  input: Readonly<{
    journalDate?: string;
    sourceRevisionId: string;
    sourceKind: string;
    memoryId?: string;
  }>,
): string {
  if (input.journalDate !== undefined) {
    const query = new URLSearchParams({
      source: input.sourceKind,
      revision: input.sourceRevisionId,
    });
    return `/journal/${input.journalDate}?${query.toString()}`;
  }
  if (input.memoryId !== undefined)
    return `/memories?memory=${encodeURIComponent(input.memoryId)}`;
  throw new Error('A search result must link to a Journal Day or memory.');
}
