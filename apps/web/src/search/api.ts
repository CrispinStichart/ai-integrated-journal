import {
  lexicalSearchPageSchema,
  problemDetailsSchema,
  type LexicalSearchRequest,
} from '@journal/contracts';

export type SearchInput = Omit<LexicalSearchRequest, 'limit' | 'cursor'>;

export async function lexicalSearch(input: SearchInput, cursor?: string) {
  const query = new URLSearchParams({ q: input.q, limit: '20' });
  if (cursor !== undefined) query.set('cursor', cursor);
  if (input.layers !== undefined) query.set('layers', input.layers.join(','));
  if (input.dateFrom !== undefined) query.set('dateFrom', input.dateFrom);
  if (input.dateTo !== undefined) query.set('dateTo', input.dateTo);
  if (input.contributionTypes !== undefined)
    query.set('contributionTypes', input.contributionTypes.join(','));
  if (input.processorId !== undefined)
    query.set('processorId', input.processorId);
  if (input.resultType !== undefined) query.set('resultType', input.resultType);
  if (input.entity !== undefined) query.set('entity', input.entity);
  if (input.authority !== undefined) query.set('authority', input.authority);
  const response = await fetch(`/api/v1/search?${query}`, {
    credentials: 'same-origin',
  });
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(body);
    throw new Error(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'Search could not be completed.',
    );
  }
  return lexicalSearchPageSchema.parse(body);
}
