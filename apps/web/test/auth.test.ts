// @vitest-environment jsdom

import {
  startAuthentication,
  startRegistration,
} from '@simplewebauthn/browser';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAuthentication } from '../src/auth';
import { browserMetadata } from '../src/storage/indexed-db';

vi.mock('@simplewebauthn/browser', () => ({
  startAuthentication: vi.fn(async () => ({ id: 'credential', response: {} })),
  startRegistration: vi.fn(async () => ({ id: 'credential', response: {} })),
}));

vi.mock('../src/storage/indexed-db', () => ({
  browserMetadata: { destroy: vi.fn(async () => undefined) },
}));

const session = {
  displayName: 'Owner',
  csrfToken: 'c'.repeat(43),
  sessionExpiresAt: '2026-08-17T12:00:00.000Z',
};

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mockResponses(...responses: Response[]): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn();
  responses.forEach((response) => fetchMock.mockResolvedValueOnce(response));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('browser authentication workflow (SEC-001, SEC-002)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('initializes, bootstraps, registers a passkey, and clears local data on logout', async () => {
    const cacheDelete = vi.fn(async () => true);
    vi.stubGlobal('caches', {
      keys: vi.fn(async () => ['journal-navigation']),
      delete: cacheDelete,
    });
    const recoveryCodes = Array.from(
      { length: 10 },
      () => 'AAAAA-AAAAA-AAAAA-22222',
    );
    const fetchMock = mockResponses(
      json({ bootstrapRequired: true, authenticated: false }),
      json({ ...session, recoveryCodes }),
      json({ options: { challenge: 'registration' } }),
      json(session),
      json({ loggedOut: true }),
    );
    const auth = useAuthentication();

    await auth.initialize();
    expect(auth.bootstrapRequired.value).toBe(true);
    await expect(
      auth.bootstrap({
        displayName: 'Owner',
        password: 'a strong local password',
        journalTimeZone: 'UTC',
      }),
    ).resolves.toMatchObject({ recoveryCodes });
    expect(auth.authenticated.value).toBe(true);

    await auth.registerPasskey();
    expect(startRegistration).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[2]?.[1]?.headers).toEqual({
      'x-csrf-token': session.csrfToken,
    });

    await auth.logout();
    expect(browserMetadata.destroy).toHaveBeenCalledOnce();
    expect(cacheDelete).toHaveBeenCalledWith('journal-navigation');
    expect(auth.authenticated.value).toBe(false);
  });

  it('supports password, recovery-code, and passkey login', async () => {
    const recoveryCodes = ['BBBBB-BBBBB-BBBBB-BBBBB'];
    mockResponses(
      json({ bootstrapRequired: false, authenticated: false }),
      json(session),
      json({ ...session, recoveryCodes }),
      json({ options: { challenge: 'authentication' } }),
      json(session),
    );
    const auth = useAuthentication();

    await auth.initialize();
    await expect(auth.login('password')).resolves.toBeUndefined();
    await expect(
      auth.recover('AAAAA-AAAAA-AAAAA-AAAAA', 'replacement password'),
    ).resolves.toMatchObject({ recoveryCodes });
    await expect(auth.loginWithPasskey()).resolves.toBeUndefined();
    expect(startAuthentication).toHaveBeenCalledOnce();
  });

  it('surfaces RFC problem details and handles logout without an active CSRF token', async () => {
    const fetchMock = mockResponses(
      json({ bootstrapRequired: false, authenticated: false }),
      json({ title: 'Invalid credentials', detail: 'Try again' }, 401),
    );
    const auth = useAuthentication();
    await auth.initialize();

    await expect(auth.login('bad')).rejects.toThrow('Try again');
    await auth.logout();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('falls back to a generic error for non-JSON failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('unavailable', { status: 503 })),
    );
    const auth = useAuthentication();
    await expect(auth.initialize()).rejects.toThrow(
      'Authentication request failed',
    );
    expect(auth.loading.value).toBe(false);
  });
});
