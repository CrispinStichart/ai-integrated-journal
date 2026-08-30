// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getSettings,
  listActiveSessions,
  revokeActiveSession,
  updateProviderSettings,
  updateSettings,
} from '../src/settings/api';

const settings = {
  revision: 2,
  journalTimezone: 'UTC',
  retention: {
    materialGraceDays: 30,
    audioGraceDays: 30,
    rawResponseRetention: 'days_30' as const,
    originalAudioRetention: 'indefinite' as const,
  },
  backup: {
    configured: false,
    scheduleEnabled: false,
    schedule: '03:30 UTC daily' as const,
    encrypted: true as const,
    retentionSummary: '7 daily, 5 weekly, and 12 monthly snapshots' as const,
  },
  privacy: {
    journalPrivateByDefault: true as const,
    contentFreeLogs: true as const,
    credentialsExcludedFromExports: true as const,
    externalProcessingRequiresProviderEnablement: true as const,
    offlineCacheEncrypted: true as const,
  },
  providers: [],
};

afterEach(() => vi.unstubAllGlobals());

describe('settings browser API', () => {
  it('[SEC-001–SEC-006] uses same-origin authenticated reads', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(settings), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await expect(getSettings()).resolves.toEqual(settings);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/settings', {
      credentials: 'same-origin',
      headers: {},
    });
  });

  it('[TIME-001–TIME-003][RET-001–RET-007] sends conditional idempotent settings mutations', async () => {
    const updated = { ...settings, revision: 3, journalTimezone: 'Etc/UTC' };
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            settings: updated,
            idempotency: { key: 'settings-key', replayed: false },
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    await updateSettings({
      settings,
      changes: {
        journalTimezone: 'Etc/UTC',
        retention: settings.retention,
        backupScheduleEnabled: false,
      },
      csrfToken: 'csrf',
      idempotencyKey: 'settings-key',
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/settings',
      expect.objectContaining({
        method: 'PUT',
        credentials: 'same-origin',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf',
          'idempotency-key': 'settings-key',
          'if-match': '"settings-2"',
        }),
      }),
    );
  });

  it('[SEC-002–SEC-006] writes credentials and session revocation only through CSRF-protected calls', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            provider: {
              id: 'synthetic.external',
              displayName: 'Synthetic',
              capabilities: ['speech_to_text'],
              disclosure: {
                contentRecipient: 'Synthetic',
                external: true,
                retention: { status: 'unknown' },
                trainingUse: { status: 'unknown' },
              },
              disclosureVersion: 'a'.repeat(64),
              enabled: false,
              models: {},
              credentialConfigured: true,
              credentialStorageAvailable: true,
              revision: 1,
            },
            idempotency: { key: 'provider-key', replayed: false },
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ revoked: true, currentSession: false }), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await updateProviderSettings({
      settings,
      providerId: 'synthetic.external',
      changes: { enabled: false, models: {}, credential: 'private-key' },
      csrfToken: 'csrf',
      idempotencyKey: 'provider-key',
    });
    await revokeActiveSession({
      sessionId: '019c5b90-0000-7000-8000-000000000081',
      csrfToken: 'csrf',
    });
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({
      method: 'PUT',
      credentials: 'same-origin',
    });
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({
      method: 'DELETE',
      credentials: 'same-origin',
      headers: { 'x-csrf-token': 'csrf' },
    });
  });

  it('[SEC-002] validates secret-free active session metadata', async () => {
    const session = {
      id: '019c5b90-0000-7000-8000-000000000081',
      current: true,
      createdAt: '2026-08-30T01:00:00.000Z',
      lastUsedAt: '2026-08-30T02:00:00.000Z',
      idleExpiresAt: '2026-08-30T02:30:00.000Z',
      absoluteExpiresAt: '2026-09-06T01:00:00.000Z',
    };
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ sessions: [session] }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listActiveSessions()).resolves.toEqual([session]);
    expect(fetchMock).toHaveBeenCalledWith('/api/v1/auth/sessions', {
      credentials: 'same-origin',
      headers: {},
    });
  });

  it('[SEC-001] reports problem detail without reflecting request secrets', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              title: 'Settings validation failed',
              detail: 'Credential storage is unavailable.',
            }),
            { status: 400 },
          ),
      ),
    );

    await expect(getSettings()).rejects.toMatchObject({
      status: 400,
      message: 'Credential storage is unavailable.',
    });
  });

  it.each([
    [{ title: 'Settings unavailable' }, 'Settings unavailable'],
    [{}, 'Settings request failed.'],
  ])(
    '[SEC-001] provides a safe error message when problem detail is absent',
    async (problem, message) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(
          async () => new Response(JSON.stringify(problem), { status: 503 }),
        ),
      );
      await expect(getSettings()).rejects.toMatchObject({
        status: 503,
        message,
      });
    },
  );
});
