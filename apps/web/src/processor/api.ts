import {
  createProcessorRequestSchema,
  problemDetailsSchema,
  processorDryRunRequestSchema,
  processorDryRunResponseSchema,
  processorListResponseSchema,
  processorMutationResponseSchema,
  publishProcessorVersionRequestSchema,
  updateProcessorRequestSchema,
  type ProcessorDefinitionDraft,
  type ProcessorDryRunResponse,
  type ProcessorResource,
} from '@journal/contracts';

export class ProcessorApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ProcessorApiError';
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
    throw new ProcessorApiError(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'The processor request failed.',
      response.status,
      problem.success ? problem.data.code : 'unknown',
    );
  }
  return body;
}

function mutationHeaders(
  csrfToken: string,
  idempotencyKey?: string,
  revision?: number,
): HeadersInit {
  return {
    'x-csrf-token': csrfToken,
    ...(idempotencyKey === undefined
      ? {}
      : { 'idempotency-key': idempotencyKey }),
    ...(revision === undefined
      ? {}
      : { 'if-match': `"processor-${revision}"` }),
  };
}

export async function listProcessors(): Promise<readonly ProcessorResource[]> {
  return processorListResponseSchema.parse(await request('/api/v1/processors'))
    .items;
}

export async function dryRunProcessorDefinition(input: {
  csrfToken: string;
  processorId?: string;
  versionId?: string;
  definition: ProcessorDefinitionDraft;
}): Promise<ProcessorDryRunResponse> {
  const body = processorDryRunRequestSchema.parse({
    ...(input.processorId === undefined
      ? {}
      : { processorId: input.processorId }),
    ...(input.versionId === undefined ? {} : { versionId: input.versionId }),
    definition: input.definition,
  });
  return processorDryRunResponseSchema.parse(
    await request('/api/v1/processor-versions/dry-run', {
      method: 'POST',
      headers: mutationHeaders(input.csrfToken),
      body: JSON.stringify(body),
    }),
  );
}

export async function createProcessor(input: {
  csrfToken: string;
  idempotencyKey: string;
  id: string;
  versionId: string;
  key: string;
  name: string;
  purpose: string;
  definition: ProcessorDefinitionDraft;
}): Promise<ProcessorResource> {
  const body = createProcessorRequestSchema.parse({
    id: input.id,
    versionId: input.versionId,
    key: input.key,
    name: input.name,
    purpose: input.purpose,
    definition: input.definition,
  });
  return processorMutationResponseSchema.parse(
    await request('/api/v1/processors', {
      method: 'POST',
      headers: mutationHeaders(input.csrfToken, input.idempotencyKey),
      body: JSON.stringify(body),
    }),
  ).processor;
}

export async function publishProcessorVersion(input: {
  csrfToken: string;
  idempotencyKey: string;
  processorId: string;
  revision: number;
  versionId: string;
  definition: ProcessorDefinitionDraft;
}): Promise<ProcessorResource> {
  const body = publishProcessorVersionRequestSchema.parse({
    versionId: input.versionId,
    definition: input.definition,
  });
  return processorMutationResponseSchema.parse(
    await request(`/api/v1/processors/${input.processorId}/versions`, {
      method: 'POST',
      headers: mutationHeaders(
        input.csrfToken,
        input.idempotencyKey,
        input.revision,
      ),
      body: JSON.stringify(body),
    }),
  ).processor;
}

export async function updateProcessor(input: {
  csrfToken: string;
  idempotencyKey: string;
  processorId: string;
  revision: number;
  changes: {
    name?: string;
    purpose?: string;
    enabled?: boolean;
    requirementMode?: 'optional' | 'required';
    currentVersionId?: string;
  };
}): Promise<ProcessorResource> {
  const body = updateProcessorRequestSchema.parse(input.changes);
  return processorMutationResponseSchema.parse(
    await request(`/api/v1/processors/${input.processorId}`, {
      method: 'PATCH',
      headers: mutationHeaders(
        input.csrfToken,
        input.idempotencyKey,
        input.revision,
      ),
      body: JSON.stringify(body),
    }),
  ).processor;
}
