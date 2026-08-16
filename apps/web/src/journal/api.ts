import {
  contributionMutationResponseSchema,
  contributionRevisionPageSchema,
  contributionSchema,
  createContributionRequestSchema,
  editContributionRequestSchema,
  journalDaySummaryPageSchema,
  journalDayViewSchema,
  problemDetailsSchema,
  type ContributionResource,
  type ContributionRevisionResource,
  type CreateContributionRequest,
  type JournalDaySummary,
  type JournalDayView,
} from '@journal/contracts';

interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor?: string;
}

export class JournalApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
    headers: {
      ...(init?.body === undefined
        ? {}
        : { 'content-type': 'application/json' }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    throw new JournalApiError(
      parsed.success
        ? (parsed.data.detail ?? parsed.data.title)
        : 'The journal request failed. Please try again.',
      response.status,
      parsed.success ? parsed.data.code : 'unknown',
    );
  }
  return response;
}

async function jsonRequest(path: string, init?: RequestInit): Promise<unknown> {
  return (await request(path, init)).json();
}

function mutationHeaders(
  csrfToken: string,
  idempotencyKey: string,
  revision?: number,
): HeadersInit {
  return {
    'idempotency-key': idempotencyKey,
    'x-csrf-token': csrfToken,
    ...(revision === undefined ? {} : { 'if-match': `"revision-${revision}"` }),
  };
}

export async function listJournalDays(
  cursor?: string,
): Promise<Page<JournalDaySummary>> {
  const parameters = new URLSearchParams({ limit: '100' });
  if (cursor !== undefined) parameters.set('cursor', cursor);
  const page = journalDaySummaryPageSchema.parse(
    await jsonRequest(`/api/v1/journal-days?${parameters.toString()}`),
  );
  return {
    items: page.items,
    ...(page.page.nextCursor === undefined
      ? {}
      : { nextCursor: page.page.nextCursor }),
  };
}

export async function getJournalDay(
  journalDate: string,
  includeDeleted = true,
): Promise<JournalDayView | undefined> {
  try {
    return journalDayViewSchema.parse(
      await jsonRequest(
        `/api/v1/journal-days/${journalDate}?includeDeleted=${String(includeDeleted)}`,
      ),
    );
  } catch (error) {
    if (error instanceof JournalApiError && error.status === 404)
      return undefined;
    throw error;
  }
}

export async function getContribution(
  id: string,
): Promise<ContributionResource> {
  return contributionSchema.parse(
    await jsonRequest(`/api/v1/contributions/${id}?includeDeleted=true`),
  );
}

export async function listContributionRevisions(
  id: string,
): Promise<readonly ContributionRevisionResource[]> {
  const revisions: ContributionRevisionResource[] = [];
  let cursor: string | undefined;
  do {
    const parameters = new URLSearchParams({ limit: '100' });
    if (cursor !== undefined) parameters.set('cursor', cursor);
    const page = contributionRevisionPageSchema.parse(
      await jsonRequest(
        `/api/v1/contributions/${id}/revisions?${parameters.toString()}`,
      ),
    );
    revisions.push(...page.items);
    cursor = page.page.nextCursor;
  } while (cursor !== undefined);
  return revisions;
}

export async function createContribution(
  input: CreateContributionRequest,
  csrfToken: string,
  idempotencyKey: string,
): Promise<ContributionResource> {
  const body = createContributionRequestSchema.parse(input);
  const result = contributionMutationResponseSchema.parse(
    await jsonRequest('/api/v1/contributions', {
      method: 'POST',
      headers: mutationHeaders(csrfToken, idempotencyKey),
      body: JSON.stringify(body),
    }),
  );
  return result.contribution;
}

export async function editContribution(
  contribution: ContributionResource,
  text: string,
  editReason: string | undefined,
  revisionId: string,
  csrfToken: string,
  idempotencyKey: string,
): Promise<ContributionResource> {
  const revision = contribution.currentRevision?.revision;
  if (revision === undefined)
    throw new Error('This contribution cannot be edited.');
  return editContributionAtRevision(
    contribution.id,
    revision,
    text,
    editReason,
    revisionId,
    csrfToken,
    idempotencyKey,
  );
}

export async function editContributionAtRevision(
  contributionId: string,
  revision: number,
  text: string,
  editReason: string | undefined,
  revisionId: string,
  csrfToken: string,
  idempotencyKey: string,
): Promise<ContributionResource> {
  const body = editContributionRequestSchema.parse({
    revisionId,
    text,
    ...(editReason === undefined || editReason.trim() === ''
      ? {}
      : { editReason: editReason.trim() }),
  });
  const result = contributionMutationResponseSchema.parse(
    await jsonRequest(`/api/v1/contributions/${contributionId}`, {
      method: 'PATCH',
      headers: mutationHeaders(csrfToken, idempotencyKey, revision),
      body: JSON.stringify(body),
    }),
  );
  return result.contribution;
}

export async function setContributionDeleted(
  contribution: ContributionResource,
  deleted: boolean,
  csrfToken: string,
  idempotencyKey: string,
): Promise<ContributionResource> {
  const revision = contribution.currentRevision?.revision;
  if (revision === undefined)
    throw new Error('This contribution cannot be changed.');
  const result = contributionMutationResponseSchema.parse(
    await jsonRequest(
      `/api/v1/contributions/${contribution.id}${deleted ? '' : '/restore'}`,
      {
        method: deleted ? 'DELETE' : 'POST',
        headers: mutationHeaders(csrfToken, idempotencyKey, revision),
      },
    ),
  );
  return result.contribution;
}

export function createUuidV7(now = Date.now()): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let timestamp = BigInt(now);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(timestamp & 0xffn);
    timestamp >>= 8n;
  }
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10).join('')}`;
}
