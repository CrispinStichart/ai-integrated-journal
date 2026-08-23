import {
  createFeedbackRequestSchema,
  feedbackMutationResponseSchema,
  memoryMutationRequestSchema,
  memoryMutationResponseSchema,
  memoryPageSchema,
  problemDetailsSchema,
  type CreateFeedbackRequest,
  type MemoryMutationRequest,
  type MemoryResource,
} from '@journal/contracts';

async function request(path: string, init?: RequestInit): Promise<unknown> {
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
  const body: unknown = await response.json().catch(() => undefined);
  if (!response.ok) {
    const problem = problemDetailsSchema.safeParse(body);
    throw new Error(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'The memory request failed.',
    );
  }
  return body;
}

export async function listMemories(
  input: Readonly<{
    q?: string;
    includeDisabled?: boolean;
    includeDeleted?: boolean;
  }> = {},
): Promise<readonly MemoryResource[]> {
  const query = new URLSearchParams({ limit: '50' });
  if (input.q) query.set('q', input.q);
  if (input.includeDisabled) query.set('includeDisabled', 'true');
  if (input.includeDeleted) query.set('includeDeleted', 'true');
  return memoryPageSchema.parse(await request(`/api/v1/memories?${query}`))
    .items;
}

export async function mutateMemory(
  input: Readonly<{
    memoryId: string;
    revision: number;
    mutation: MemoryMutationRequest;
    csrfToken: string;
    idempotencyKey: string;
  }>,
): Promise<MemoryResource> {
  const body = memoryMutationRequestSchema.parse(input.mutation);
  return memoryMutationResponseSchema.parse(
    await request(`/api/v1/memories/${input.memoryId}/mutations`, {
      method: 'POST',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
        'if-match': `"memory-${input.revision}"`,
      },
      body: JSON.stringify(body),
    }),
  ).memory;
}

export async function createFeedback(
  input: Readonly<{
    feedback: CreateFeedbackRequest;
    csrfToken: string;
    idempotencyKey: string;
  }>,
) {
  const body = createFeedbackRequestSchema.parse(input.feedback);
  return feedbackMutationResponseSchema.parse(
    await request('/api/v1/feedback', {
      method: 'POST',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  );
}
