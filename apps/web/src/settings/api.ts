import {
  activeSessionListSchema,
  providerSettingsMutationResponseSchema,
  revokeSessionResponseSchema,
  settingsMutationResponseSchema,
  settingsResourceSchema,
  updateProviderSettingsRequestSchema,
  updateSettingsRequestSchema,
  type ActiveSessionResource,
  type SettingsResource,
  type UpdateProviderSettingsRequest,
  type UpdateSettingsRequest,
} from '@journal/contracts';

interface ProblemBody {
  title?: string;
  detail?: string;
}

export class SettingsApiError extends Error {
  public constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'SettingsApiError';
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
  const body: unknown = await response.json().catch(() => ({}));
  if (!response.ok) {
    const problem = body as ProblemBody;
    throw new SettingsApiError(
      response.status,
      problem.detail ?? problem.title ?? 'Settings request failed.',
    );
  }
  return body;
}

export function getSettings(): Promise<SettingsResource> {
  return request('/api/v1/settings').then((value) =>
    settingsResourceSchema.parse(value),
  );
}

export async function updateSettings(input: {
  settings: SettingsResource;
  changes: UpdateSettingsRequest;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<SettingsResource> {
  const body = updateSettingsRequestSchema.parse(input.changes);
  const response = settingsMutationResponseSchema.parse(
    await request('/api/v1/settings', {
      method: 'PUT',
      headers: {
        'x-csrf-token': input.csrfToken,
        'idempotency-key': input.idempotencyKey,
        'if-match': `"settings-${String(input.settings.revision)}"`,
      },
      body: JSON.stringify(body),
    }),
  );
  return response.settings;
}

export async function updateProviderSettings(input: {
  settings: SettingsResource;
  providerId: string;
  changes: UpdateProviderSettingsRequest;
  csrfToken: string;
  idempotencyKey: string;
}): Promise<void> {
  const body = updateProviderSettingsRequestSchema.parse(input.changes);
  providerSettingsMutationResponseSchema.parse(
    await request(
      `/api/v1/settings/providers/${encodeURIComponent(input.providerId)}`,
      {
        method: 'PUT',
        headers: {
          'x-csrf-token': input.csrfToken,
          'idempotency-key': input.idempotencyKey,
          'if-match': `"settings-${String(input.settings.revision)}"`,
        },
        body: JSON.stringify(body),
      },
    ),
  );
}

export function listActiveSessions(): Promise<
  readonly ActiveSessionResource[]
> {
  return request('/api/v1/auth/sessions').then(
    (value) => activeSessionListSchema.parse(value).sessions,
  );
}

export async function revokeActiveSession(input: {
  sessionId: string;
  csrfToken: string;
}): Promise<{ currentSession: boolean }> {
  const response = revokeSessionResponseSchema.parse(
    await request(`/api/v1/auth/sessions/${input.sessionId}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': input.csrfToken },
    }),
  );
  return { currentSession: response.currentSession };
}
