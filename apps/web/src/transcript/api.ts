import {
  editCorrectedTranscriptRequestSchema,
  problemDetailsSchema,
  recordingTranscriptInspectorSchema,
  transcriptMutationResponseSchema,
  transcriptRevisionHistorySchema,
  type RecordingTranscriptInspector,
  type TranscriptRevisionResource,
} from '@journal/contracts';

export class TranscriptApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'TranscriptApiError';
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
    throw new TranscriptApiError(
      parsed.success
        ? (parsed.data.detail ?? parsed.data.title)
        : 'The transcript request failed. Please try again.',
      response.status,
      parsed.success ? parsed.data.code : 'unknown',
    );
  }
  return response;
}

function mutationHeaders(
  csrfToken: string,
  idempotencyKey: string,
  revision: number,
): HeadersInit {
  return {
    'idempotency-key': idempotencyKey,
    'if-match': `"revision-${revision}"`,
    'x-csrf-token': csrfToken,
  };
}

export async function getRecordingTranscripts(
  recordingId: string,
): Promise<RecordingTranscriptInspector> {
  return recordingTranscriptInspectorSchema.parse(
    await (
      await request(`/api/v1/recordings/${recordingId}/transcripts`)
    ).json(),
  );
}

export async function listTranscriptRevisions(
  transcriptId: string,
): Promise<readonly TranscriptRevisionResource[]> {
  return transcriptRevisionHistorySchema.parse(
    await (
      await request(`/api/v1/transcripts/${transcriptId}/revisions`)
    ).json(),
  ).items;
}

export async function editCorrectedTranscript(input: {
  transcriptId: string;
  revision: number;
  text: string;
  editReason?: string;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<RecordingTranscriptInspector> {
  const body = editCorrectedTranscriptRequestSchema.parse({
    text: input.text,
    ...(input.editReason === undefined ? {} : { editReason: input.editReason }),
  });
  return transcriptMutationResponseSchema.parse(
    await (
      await request(`/api/v1/transcripts/${input.transcriptId}`, {
        method: 'PATCH',
        headers: mutationHeaders(
          input.csrfToken,
          input.idempotencyKey,
          input.revision,
        ),
        body: JSON.stringify(body),
      })
    ).json(),
  ).inspector;
}

export async function retryTranscriptCleanup(input: {
  transcriptId: string;
  revision: number;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<RecordingTranscriptInspector> {
  return transcriptMutationResponseSchema.parse(
    await (
      await request(`/api/v1/transcripts/${input.transcriptId}/cleanup/retry`, {
        method: 'POST',
        headers: mutationHeaders(
          input.csrfToken,
          input.idempotencyKey,
          input.revision,
        ),
      })
    ).json(),
  ).inspector;
}
