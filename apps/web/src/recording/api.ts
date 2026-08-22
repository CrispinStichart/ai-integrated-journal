import {
  createRecordingRequestSchema,
  finalizeRecordingRequestSchema,
  problemDetailsSchema,
  recordingChunkUploadResponseSchema,
  recordingMutationResponseSchema,
  recordingUploadStatusSchema,
  type CreateRecordingRequest,
  type FinalizeRecordingRequest,
  type RecordingResource,
} from '@journal/contracts';

export class RecordingApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = 'RecordingApiError';
  }
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: 'same-origin',
  });
  if (!response.ok) {
    const parsed = problemDetailsSchema.safeParse(
      await response.json().catch(() => undefined),
    );
    throw new RecordingApiError(
      parsed.success
        ? (parsed.data.detail ?? parsed.data.title)
        : 'Audio synchronization failed. Please try again.',
      response.status,
      parsed.success ? parsed.data.code : 'unknown',
    );
  }
  return response;
}

function mutationHeaders(csrfToken: string, key: string): HeadersInit {
  return { 'idempotency-key': key, 'x-csrf-token': csrfToken };
}

export async function createRecording(
  input: CreateRecordingRequest,
  csrfToken: string,
): Promise<RecordingResource> {
  const parsed = createRecordingRequestSchema.parse(input);
  const result = recordingMutationResponseSchema.parse(
    await (
      await request('/api/v1/recordings', {
        method: 'POST',
        headers: {
          ...mutationHeaders(csrfToken, `create-${parsed.recordingId}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsed),
      })
    ).json(),
  );
  return result.recording;
}

export async function getRecordingUpload(recordingId: string, after?: number) {
  const query = new URLSearchParams({ limit: '1000' });
  if (after !== undefined) query.set('after', String(after));
  return recordingUploadStatusSchema.parse(
    await (
      await request(
        `/api/v1/recordings/${recordingId}/upload?${query.toString()}`,
      )
    ).json(),
  );
}

export async function uploadRecordingChunk(
  recordingId: string,
  index: number,
  checksum: string,
  bytes: ArrayBuffer,
  csrfToken: string,
): Promise<void> {
  recordingChunkUploadResponseSchema.parse(
    await (
      await request(`/api/v1/recordings/${recordingId}/chunks/${index}`, {
        method: 'PUT',
        headers: {
          ...mutationHeaders(csrfToken, `chunk-${recordingId}-${index}`),
          'content-type': 'application/octet-stream',
          'x-content-sha256': checksum,
        },
        body: bytes,
      })
    ).json(),
  );
}

export async function finalizeRecording(
  recordingId: string,
  input: FinalizeRecordingRequest,
  csrfToken: string,
): Promise<RecordingResource> {
  const parsed = finalizeRecordingRequestSchema.parse(input);
  const result = recordingMutationResponseSchema.parse(
    await (
      await request(`/api/v1/recordings/${recordingId}/finalize`, {
        method: 'POST',
        headers: {
          ...mutationHeaders(csrfToken, `finalize-${recordingId}`),
          'content-type': 'application/json',
        },
        body: JSON.stringify(parsed),
      })
    ).json(),
  );
  return result.recording;
}

export async function retryRecordingFinalization(
  recordingId: string,
  csrfToken: string,
): Promise<RecordingResource> {
  const result = recordingMutationResponseSchema.parse(
    await (
      await request(`/api/v1/recordings/${recordingId}/retry`, {
        method: 'POST',
        headers: mutationHeaders(csrfToken, `retry-${recordingId}`),
      })
    ).json(),
  );
  return result.recording;
}

export function recordingAudioUrl(recordingId: string): string {
  return `/api/v1/recordings/${recordingId}/audio`;
}
