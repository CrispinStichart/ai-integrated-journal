import {
  nudgeActionRequestSchema,
  nudgeDayResourceSchema,
  nudgeMutationResponseSchema,
  nudgePreferenceMutationResponseSchema,
  nudgePreferenceSchema,
  problemDetailsSchema,
  updateNudgePreferenceRequestSchema,
  type NudgeActionRequest,
  type NudgeDayResource,
  type NudgePreference,
  type UpdateNudgePreferenceRequest,
} from '@journal/contracts';

export class NudgeApiError extends Error {
  public constructor(
    message: string,
    public readonly status: number,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'NudgeApiError';
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
    throw new NudgeApiError(
      problem.success
        ? (problem.data.detail ?? problem.data.title)
        : 'The required-information request failed.',
      response.status,
      problem.success ? problem.data.code : 'unknown',
    );
  }
  return body;
}

export function getNudgeDay(journalDate: string): Promise<NudgeDayResource> {
  return request(
    `/api/v1/nudges?journalDate=${encodeURIComponent(journalDate)}`,
  ).then((value) => nudgeDayResourceSchema.parse(value));
}

export async function actOnNudge(
  input: Readonly<{
    digestId: string;
    digestRevision: number;
    action: NudgeActionRequest;
    csrfToken: string;
    idempotencyKey: string;
  }>,
): Promise<NudgeDayResource> {
  const body = nudgeActionRequestSchema.parse(input.action);
  return nudgeMutationResponseSchema.parse(
    await request(`/api/v1/nudges/${input.digestId}/actions`, {
      method: 'POST',
      headers: {
        'idempotency-key': input.idempotencyKey,
        'if-match': `"nudge-${input.digestRevision}"`,
        'x-csrf-token': input.csrfToken,
      },
      body: JSON.stringify(body),
    }),
  ).day;
}

export function getNudgePreferences(): Promise<NudgePreference> {
  return request('/api/v1/nudges/preferences').then((value) =>
    nudgePreferenceSchema.parse(value),
  );
}

export async function updateNudgePreferences(
  input: Readonly<{
    preference: NudgePreference;
    changes: UpdateNudgePreferenceRequest;
    csrfToken: string;
    idempotencyKey: string;
  }>,
): Promise<NudgePreference> {
  const body = updateNudgePreferenceRequestSchema.parse(input.changes);
  return nudgePreferenceMutationResponseSchema.parse(
    await request('/api/v1/nudges/preferences', {
      method: 'PUT',
      headers: {
        'idempotency-key': input.idempotencyKey,
        'if-match': `"nudge-preferences-${input.preference.revision}"`,
        'x-csrf-token': input.csrfToken,
      },
      body: JSON.stringify(body),
    }),
  ).preference;
}
