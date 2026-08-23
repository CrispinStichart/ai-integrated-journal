import {
  problemDetailsSchema,
  reprocessingBatchMutationResponseSchema,
  reprocessingBatchPageSchema,
  reprocessingBatchSchema,
  reprocessingPreviewRequestSchema,
  reprocessingPreviewResponseSchema,
  startReprocessingRequestSchema,
  type ReprocessingBatch,
  type ReprocessingPreviewRequest,
  type ReprocessingPreviewResponse,
} from '@journal/contracts';

export class ReprocessingApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ReprocessingApiError';
  }
}

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
    throw new ReprocessingApiError(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'The reprocessing request failed.',
      response.status,
      problem.success ? problem.data.code : 'unknown',
    );
  }
  return body;
}

export async function previewReprocessing(
  input: ReprocessingPreviewRequest,
  csrfToken: string,
): Promise<ReprocessingPreviewResponse> {
  const body = reprocessingPreviewRequestSchema.parse(input);
  return reprocessingPreviewResponseSchema.parse(
    await request('/api/v1/processing-runs/reprocessing/preview', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
      body: JSON.stringify(body),
    }),
  );
}

export async function startReprocessing(input: {
  preview: ReprocessingPreviewRequest;
  impactFingerprint: string;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<ReprocessingBatch> {
  const body = startReprocessingRequestSchema.parse({
    preview: input.preview,
    impactFingerprint: input.impactFingerprint,
  });
  return reprocessingBatchMutationResponseSchema.parse(
    await request('/api/v1/reprocessing-batches', {
      method: 'POST',
      headers: {
        'idempotency-key': input.idempotencyKey,
        'x-csrf-token': input.csrfToken,
      },
      body: JSON.stringify(body),
    }),
  ).batch;
}

export async function listReprocessingBatches(): Promise<
  readonly ReprocessingBatch[]
> {
  return reprocessingBatchPageSchema.parse(
    await request('/api/v1/reprocessing-batches?limit=50'),
  ).items;
}

export async function getReprocessingBatch(
  id: string,
): Promise<ReprocessingBatch> {
  return reprocessingBatchSchema.parse(
    await request(`/api/v1/reprocessing-batches/${id}`),
  );
}

export async function cancelReprocessing(input: {
  batch: ReprocessingBatch;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<ReprocessingBatch> {
  return reprocessingBatchMutationResponseSchema.parse(
    await request(`/api/v1/reprocessing-batches/${input.batch.id}/cancel`, {
      method: 'POST',
      headers: {
        'idempotency-key': input.idempotencyKey,
        'if-match': `"reprocessing-${input.batch.revision}"`,
        'x-csrf-token': input.csrfToken,
      },
    }),
  ).batch;
}
