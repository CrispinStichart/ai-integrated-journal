import {
  exportListResponseSchema,
  exportMutationResponseSchema,
  type CreateExportRequest,
  type ExportResource,
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
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(`Export request failed (${response.status}).`);
  return body;
}

export async function createPortableExport(
  input: CreateExportRequest,
  csrfToken: string,
  idempotencyKey: string,
): Promise<ExportResource> {
  return exportMutationResponseSchema.parse(
    await request('/api/v1/exports', {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey,
        'x-csrf-token': csrfToken,
      },
      body: JSON.stringify(input),
    }),
  ).export;
}

export async function listPortableExports(): Promise<ExportResource[]> {
  return exportListResponseSchema.parse(await request('/api/v1/exports')).items;
}

export function exportDownloadUrl(id: string): string {
  return `/api/v1/exports/${encodeURIComponent(id)}/download`;
}
