import { silentLogger } from '@journal/observability';
import { describe, expect, it, vi } from 'vitest';
import request from 'supertest';

import { createApiApp } from '../src/app.js';
import {
  AuthenticationError,
  type ActiveSession,
  type AuthenticationService,
  type IssuedSession,
} from '../src/auth.js';
import { createInMemoryEventFeed } from '../src/events.js';

const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000001';
const active: ActiveSession = {
  ownerId: '018f0000-0000-7000-8000-000000000001',
  sessionId: 'session',
  displayName: 'Owner',
  csrfToken: 'c'.repeat(43),
  expiresAt: new Date('2026-08-17T12:00:00.000Z'),
};
const issued: IssuedSession = {
  ownerId: active.ownerId,
  token: 'session-token',
  csrfToken: active.csrfToken,
  displayName: 'Owner',
  expiresAt: active.expiresAt,
};
const ACTIVE_SESSION_ID = '019c5b90-0000-7000-8000-000000000081';

function fakeService(): AuthenticationService {
  return {
    secureCookies: false,
    authenticate: vi.fn(async () => active),
    ownerExists: vi.fn(async () => true),
    passkeyCount: vi.fn(async () => 1),
    bootstrap: vi.fn(async () => ({
      ...issued,
      recoveryCodes: ['AAAAA-AAAAA-AAAAA-22222'],
    })),
    loginWithPassword: vi.fn(async () => issued),
    recover: vi.fn(async () => issued),
    assertCsrf: vi.fn(),
    registrationOptions: vi.fn(async () => ({ challenge: 'registration' })),
    verifyRegistration: vi.fn(async () => issued),
    authenticationOptions: vi.fn(async () => ({ challenge: 'authentication' })),
    loginWithPasskey: vi.fn(async () => issued),
    logout: vi.fn(async () => undefined),
    listSessions: vi.fn(async () => [
      {
        id: ACTIVE_SESSION_ID,
        current: true,
        createdAt: '2026-08-17T10:00:00.000Z',
        lastUsedAt: '2026-08-17T11:00:00.000Z',
        idleExpiresAt: '2026-08-17T11:30:00.000Z',
        absoluteExpiresAt: '2026-08-17T12:00:00.000Z',
      },
    ]),
    revokeOwnedSession: vi.fn(async () => ({
      revoked: true,
      currentSession: true,
    })),
    sessionCookie: vi.fn(
      (token: string) =>
        `journal_session=${token}; Path=/; HttpOnly; SameSite=Strict`,
    ),
    csrfCookie: vi.fn(
      (token: string) => `journal_csrf=${token}; Path=/; SameSite=Strict`,
    ),
    clearCookies: vi.fn(() => [
      'journal_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0',
      'journal_csrf=; Path=/; SameSite=Strict; Max-Age=0',
    ]),
  } as unknown as AuthenticationService;
}

function app(service: AuthenticationService) {
  return createApiApp({
    authenticator: service,
    authenticationService: service,
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
  });
}

describe('authentication HTTP routes (SEC-001, SEC-002, SEC-008)', () => {
  it('serves status, bootstrap, password login, and password recovery with no-store cookies', async () => {
    const service = fakeService();
    const api = app(service);

    const status = await request(api).get('/api/v1/auth/status').expect(200);
    expect(status.headers['cache-control']).toBe('no-store');
    expect(status.body).toMatchObject({
      authenticated: true,
      ownerId: active.ownerId,
      passkeyCount: 1,
    });

    const bootstrap = await request(api)
      .post('/api/v1/auth/bootstrap')
      .send({
        displayName: 'Owner',
        password: 'a strong local password',
        journalTimeZone: 'UTC',
      })
      .expect(201);
    expect(bootstrap.headers['set-cookie']).toHaveLength(2);
    expect(bootstrap.body.ownerId).toBe(active.ownerId);

    await request(api)
      .post('/api/v1/auth/password/login')
      .send({ password: 'password' })
      .expect(200);
    await request(api)
      .post('/api/v1/auth/password/recover')
      .send({
        recoveryCode: 'AAAAA-AAAAA-AAAAA-22222',
        newPassword: 'a replacement password',
      })
      .expect(200);
    expect(service.bootstrap).toHaveBeenCalledWith(
      expect.any(Object),
      CORRELATION_ID,
    );
    expect(service.recover).toHaveBeenCalledWith(
      'AAAAA-AAAAA-AAAAA-22222',
      'a replacement password',
      CORRELATION_ID,
    );
  });

  it('serves passkey registration and authentication ceremonies', async () => {
    const service = fakeService();
    const api = app(service);

    await request(api)
      .post('/api/v1/auth/passkeys/registration/options')
      .set('x-csrf-token', active.csrfToken)
      .expect(200);
    await request(api)
      .post('/api/v1/auth/passkeys/registration/verify')
      .set('x-csrf-token', active.csrfToken)
      .send({ response: {} })
      .expect(200);
    await request(api)
      .post('/api/v1/auth/passkeys/authentication/options')
      .expect(200);
    await request(api)
      .post('/api/v1/auth/passkeys/authentication/verify')
      .send({ response: {} })
      .expect(200);

    expect(service.assertCsrf).toHaveBeenCalledTimes(2);
    expect(service.verifyRegistration).toHaveBeenCalledWith(
      active,
      {},
      CORRELATION_ID,
    );
    expect(service.loginWithPasskey).toHaveBeenCalledOnce();
  });

  it('revokes logout sessions and instructs the browser to clear private caches', async () => {
    const service = fakeService();
    const response = await request(app(service))
      .post('/api/v1/auth/logout')
      .set('x-csrf-token', active.csrfToken)
      .expect(200);

    expect(service.logout).toHaveBeenCalledWith(active, CORRELATION_ID);
    expect(response.headers['clear-site-data']).toBe('"cache", "cookies"');
    expect(response.headers['set-cookie']).toHaveLength(2);
  });

  it('[SEC-002][SEC-008] lists active sessions and clears browser data when the current session is revoked', async () => {
    const service = fakeService();
    const listed = await request(app(service))
      .get('/api/v1/auth/sessions')
      .expect(200)
      .expect('cache-control', 'no-store');
    expect(listed.body.sessions).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(issued.token);

    const revoked = await request(app(service))
      .delete(`/api/v1/auth/sessions/${ACTIVE_SESSION_ID}`)
      .set('x-csrf-token', active.csrfToken)
      .expect(200);
    expect(service.revokeOwnedSession).toHaveBeenCalledWith(
      active,
      ACTIVE_SESSION_ID,
      CORRELATION_ID,
    );
    expect(revoked.headers['clear-site-data']).toBe('"cache", "cookies"');
    expect(revoked.headers['set-cookie']).toHaveLength(2);
  });

  it('returns stable problem details for authentication service failures', async () => {
    const service = fakeService();
    vi.mocked(service.loginWithPassword).mockRejectedValueOnce(
      new AuthenticationError(
        'authentication_required',
        401,
        'Invalid credentials',
      ),
    );

    const response = await request(app(service))
      .post('/api/v1/auth/password/login')
      .send({ password: 'wrong' })
      .expect(401);
    expect(response.body).toMatchObject({
      code: 'authentication_required',
      title: 'Invalid credentials',
    });
  });
});
