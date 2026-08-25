export interface SearchSnippetSegment {
  readonly text: string;
  readonly highlighted: boolean;
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
