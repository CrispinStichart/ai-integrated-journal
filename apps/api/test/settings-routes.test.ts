import type { SettingsResource } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import {
  SettingsConflictError,
  SettingsNotFoundError,
} from '@journal/database';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import type { AuthenticationService } from '../src/auth.js';
import { createInMemoryEventFeed } from '../src/events.js';
import type { SettingsService } from '../src/settings-service.js';
import { SettingsValidationError } from '../src/settings-service.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000071';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000072';
const DISCLOSURE_VERSION = 'a'.repeat(64);
const settings: SettingsResource = {
  revision: 4,
  journalTimezone: 'UTC',
  retention: {
    materialGraceDays: 30,
    audioGraceDays: 30,
    rawResponseRetention: 'days_30',
    originalAudioRetention: 'indefinite',
  },
  backup: {
    configured: true,
    scheduleEnabled: false,
    schedule: '03:30 UTC daily',
    encrypted: true,
    retentionSummary: '7 daily, 5 weekly, and 12 monthly snapshots',
  },
  privacy: {
    journalPrivateByDefault: true,
    contentFreeLogs: true,
    credentialsExcludedFromExports: true,
    externalProcessingRequiresProviderEnablement: true,
    offlineCacheEncrypted: true,
  },
  providers: [
    {
      id: 'synthetic.external',
      displayName: 'Synthetic provider',
      capabilities: ['speech_to_text'],
      disclosure: {
        contentRecipient: 'Synthetic provider',
        external: true,
        retention: { status: 'known', value: '30 days' },
        trainingUse: { status: 'unknown' },
      },
      disclosureVersion: DISCLOSURE_VERSION,
      enabled: false,
      models: {},
      credentialConfigured: true,
      credentialStorageAvailable: true,
      revision: 1,
    },
  ],
};
const providerSettings =
  settings.providers[0] ??
  (() => {
    throw new Error('provider fixture missing');
  })();

function service(): SettingsService {
  return {
    get: vi.fn(async () => settings),
    update: vi.fn(async (_ownerId, _revision, input) => ({
      settings: {
        ...settings,
        revision: 5,
        journalTimezone: input.journalTimezone,
        retention: input.retention,
        backup: {
          ...settings.backup,
          scheduleEnabled: input.backupScheduleEnabled,
        },
      },
      replayed: false,
    })),
    updateProvider: vi.fn(async () => ({
      provider: {
        ...providerSettings,
        enabled: true,
        credentialConfigured: true,
        revision: 2,
      },
      replayed: false,
    })),
  };
}

function app(settingsService: SettingsService, assertCsrf = vi.fn()) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? {
              ownerId: OWNER_ID,
              sessionId: 'session',
              displayName: 'Owner',
              csrfToken: 'csrf',
              expiresAt: new Date('2026-08-31T00:00:00.000Z'),
            }
          : undefined,
    },
    authenticationService: { assertCsrf } as unknown as AuthenticationService,
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    settingsService,
  });
}

describe('settings API', () => {
  it('[SEC-001–SEC-006] returns provider disclosure and credential presence without secret values', async () => {
    const response = await request(app(service()))
      .get('/api/v1/settings')
      .set('authorization', 'Bearer valid')
      .expect(200)
      .expect('etag', '"settings-4"')
      .expect('cache-control', 'no-store');

    expect(response.body.providers[0]).toMatchObject({
      credentialConfigured: true,
      enabled: false,
    });
    expect(JSON.stringify(response.body)).not.toContain('private-key');
  });

  it('[TIME-001–TIME-003][RET-001–RET-007][PORT-001–PORT-002][SEC-008] requires CSRF, idempotency, and strong settings revision', async () => {
    const settingsService = service();
    const assertCsrf = vi.fn();
    const body = {
      journalTimezone: 'America/New_York',
      retention: settings.retention,
      backupScheduleEnabled: true,
    };
    await request(app(settingsService, assertCsrf))
      .put('/api/v1/settings')
      .set('authorization', 'Bearer valid')
      .send(body)
      .expect(428);
    const response = await request(app(settingsService, assertCsrf))
      .put('/api/v1/settings')
      .set('authorization', 'Bearer valid')
      .set('x-csrf-token', 'csrf')
      .set('idempotency-key', 'settings-request-key')
      .set('if-match', '"settings-4"')
      .send(body)
      .expect(200)
      .expect('etag', '"settings-5"');

    expect(response.body.settings.journalTimezone).toBe('America/New_York');
    expect(assertCsrf).toHaveBeenCalled();
    expect(settingsService.update).toHaveBeenCalledWith(
      OWNER_ID,
      4,
      body,
      'settings-request-key',
      CORRELATION_ID,
    );
  });

  it('[SEC-003–SEC-006] accepts credentials only in a protected write and never echoes them', async () => {
    const settingsService = service();
    const response = await request(app(settingsService))
      .put('/api/v1/settings/providers/synthetic.external')
      .set('authorization', 'Bearer valid')
      .set('x-csrf-token', 'csrf')
      .set('idempotency-key', 'provider-request-key')
      .set('if-match', '"settings-4"')
      .send({
        enabled: true,
        models: { speech_to_text: 'speech-v1' },
        acknowledgeDisclosureVersion: DISCLOSURE_VERSION,
        credential: 'private-key-that-must-not-return',
      })
      .expect(200);

    expect(JSON.stringify(response.body)).not.toContain(
      'private-key-that-must-not-return',
    );
    expect(settingsService.updateProvider).toHaveBeenCalledWith(
      OWNER_ID,
      'synthetic.external',
      4,
      expect.objectContaining({
        credential: 'private-key-that-must-not-return',
      }),
      'provider-request-key',
      CORRELATION_ID,
    );
  });

  it('[SEC-001][SEC-002] rejects unauthenticated reads and malformed conditional writes', async () => {
    const settingsService = service();
    await request(app(settingsService)).get('/api/v1/settings').expect(401);
    await request(app(settingsService))
      .put('/api/v1/settings')
      .set('authorization', 'Bearer valid')
      .set('x-csrf-token', 'csrf')
      .set('idempotency-key', 'settings-request-key')
      .set('if-match', '"other-4"')
      .send({})
      .expect(400);
    expect(settingsService.update).not.toHaveBeenCalled();
  });

  it.each([
    [new SettingsNotFoundError(), 404, 'not_found'],
    [new SettingsConflictError(), 409, 'etag_mismatch'],
    [new SettingsValidationError('invalid policy'), 400, 'validation_failed'],
  ] as const)(
    '[SEC-008] maps settings service errors to stable problem details',
    async (failure, status, code) => {
      const settingsService = service();
      vi.mocked(settingsService.get).mockRejectedValueOnce(failure);
      const response = await request(app(settingsService))
        .get('/api/v1/settings')
        .set('authorization', 'Bearer valid')
        .expect(status);
      expect(response.body.code).toBe(code);
    },
  );
});
