import {
  artifactAddRequestSchema,
  artifactEditRequestSchema,
  artifactListResponseSchema,
  artifactMergeRequestSchema,
  artifactMutationResponseSchema,
  problemDetailsSchema,
  type ArtifactEditRequest,
  type ArtifactAddRequest,
  type ArtifactMergeRequest,
  type ArtifactResource,
} from '@journal/contracts';

export class ArtifactApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ArtifactApiError';
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
    throw new ArtifactApiError(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'The artifact request failed.',
      response.status,
      problem.success ? problem.data.code : 'unknown',
    );
  }
  return body;
}

export async function listArtifacts(
  journalDayId: string,
): Promise<readonly ArtifactResource[]> {
  return artifactListResponseSchema.parse(
    await request(`/api/v1/journal-days/${journalDayId}/artifacts`),
  ).items;
}

export async function addArtifact(input: {
  journalDayId: string;
  csrfToken: string;
  idempotencyKey: string;
  artifact: ArtifactAddRequest;
}): Promise<readonly ArtifactResource[]> {
  const body = artifactAddRequestSchema.parse(input.artifact);
  return artifactMutationResponseSchema.parse(
    await request(`/api/v1/journal-days/${input.journalDayId}/artifacts`, {
      method: 'POST',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
      },
      body: JSON.stringify(body),
    }),
  ).artifacts;
}

export async function editArtifact(input: {
  artifactId: string;
  revision: number;
  csrfToken: string;
  idempotencyKey: string;
  edit: ArtifactEditRequest;
}): Promise<readonly ArtifactResource[]> {
  const body = artifactEditRequestSchema.parse(input.edit);
  return artifactMutationResponseSchema.parse(
    await request(`/api/v1/artifacts/${input.artifactId}/edits`, {
      method: 'POST',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
        'if-match': `"artifact-${input.revision}"`,
      },
      body: JSON.stringify(body),
    }),
  ).artifacts;
}

export async function mergeArtifacts(input: {
  csrfToken: string;
  idempotencyKey: string;
  revisions: Readonly<Record<string, number>>;
  merge: ArtifactMergeRequest;
}): Promise<readonly ArtifactResource[]> {
  const body = artifactMergeRequestSchema.parse(input.merge);
  const etag = `"artifacts-${body.sourceArtifactIds.map((id) => `${id}:${String(input.revisions[id])}`).join(',')}"`;
  return artifactMutationResponseSchema.parse(
    await request('/api/v1/artifacts/merge', {
      method: 'POST',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
        'if-match': etag,
      },
      body: JSON.stringify(body),
    }),
  ).artifacts;
}
