import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from '@simplewebauthn/server';
import type { Request } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AuthenticationService, type ActiveSession } from '../src/auth.js';
import {
  sha256,
  type AuthenticationStore,
  type AuthenticatorRecord,
  type OwnerRecord,
} from '../src/auth-store.js';

vi.mock('@simplewebauthn/server', () => ({
  generateAuthenticationOptions: vi.fn(),
  generateRegistrationOptions: vi.fn(),
  verifyAuthenticationResponse: vi.fn(),
  verifyRegistrationResponse: vi.fn(),
}));

const NOW = new Date('2026-08-23T12:00:00.000Z');
const OWNER: OwnerRecord = {
  id: '018f0000-0000-7000-8000-000000000001',
  displayName: 'Owner',
  passwordHash: 'unused-password-hash',
};
const AUTHENTICATOR: AuthenticatorRecord = {
  id: '018f0000-0000-7000-8000-000000000002',
  userId: OWNER.id,
  credentialId: 'credential-id',
  publicKey: Buffer.from('credential-public-key').toString('base64url'),
  counter: 4,
  transports: ['internal'],
};
const ACTIVE_SESSION: ActiveSession = {
  ownerId: OWNER.id,
  sessionId: '018f0000-0000-7000-8000-000000000003',
  displayName: OWNER.displayName,
  csrfToken: 'csrf-token',
  expiresAt: new Date('2026-08-23T13:00:00.000Z'),
};

function createStore(
  overrides: Partial<AuthenticationStore> = {},
): AuthenticationStore {
  return {
    ownerExists: vi.fn(async () => true),
    createOwner: vi.fn(async () => true),
    getOwner: vi.fn(async () => OWNER),
    recoverOwner: vi.fn(async () => undefined),
    createSession: vi.fn(async () => undefined),
    findSession: vi.fn(async () => undefined),
    touchSession: vi.fn(async () => undefined),
    revokeSession: vi.fn(async () => undefined),
    listActiveSessions: vi.fn(async () => []),
    revokeOwnedSession: vi.fn(async () => false),
    countAuthenticators: vi.fn(async () => 1),
    listAuthenticators: vi.fn(async () => [AUTHENTICATOR]),
    findAuthenticator: vi.fn(async () => AUTHENTICATOR),
    saveAuthenticator: vi.fn(async () => undefined),
    updateAuthenticatorCounter: vi.fn(async () => undefined),
    saveChallenge: vi.fn(async () => undefined),
    consumeChallenge: vi.fn(async () => undefined),
    ...overrides,
  };
}

function createService(store: AuthenticationStore): AuthenticationService {
  return new AuthenticationService({
    store,
    rpId: 'journal.example',
    expectedOrigin: 'https://journal.example',
    secureCookies: true,
    now: () => NOW,
  });
}

function clientData(challenge: unknown): string {
  return Buffer.from(JSON.stringify(challenge)).toString('base64url');
}

function passkeyResponse(challenge: string): Record<string, unknown> {
  return {
    id: AUTHENTICATOR.credentialId,
    response: { clientDataJSON: clientData({ challenge }) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(generateRegistrationOptions).mockResolvedValue({
    challenge: 'registration-challenge',
  } as never);
  vi.mocked(generateAuthenticationOptions).mockResolvedValue({
    challenge: 'authentication-challenge',
  } as never);
});

describe('passkey authentication boundaries (SEC-001, SEC-002)', () => {
  it('binds registration and authentication challenges to the owner and expires them', async () => {
    const store = createStore();
    const service = createService(store);

    await expect(service.registrationOptions(ACTIVE_SESSION)).resolves.toEqual({
      challenge: 'registration-challenge',
    });
    await expect(service.authenticationOptions()).resolves.toEqual({
      challenge: 'authentication-challenge',
    });

    expect(generateRegistrationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'journal.example',
        userName: OWNER.displayName,
        excludeCredentials: [
          { id: AUTHENTICATOR.credentialId, transports: ['internal'] },
        ],
      }),
    );
    expect(generateAuthenticationOptions).toHaveBeenCalledWith(
      expect.objectContaining({
        rpID: 'journal.example',
        allowCredentials: [
          { id: AUTHENTICATOR.credentialId, transports: ['internal'] },
        ],
      }),
    );
    expect(store.saveChallenge).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        userId: OWNER.id,
        purpose: 'passkey_registration',
        challenge: 'registration-challenge',
        challengeHash: sha256('registration-challenge'),
        expiresAt: new Date('2026-08-23T12:05:00.000Z'),
      }),
    );
    expect(store.saveChallenge).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        userId: OWNER.id,
        purpose: 'passkey_authentication',
        challenge: 'authentication-challenge',
        challengeHash: sha256('authentication-challenge'),
        expiresAt: new Date('2026-08-23T12:05:00.000Z'),
      }),
    );
  });

  it('rejects malformed client data before attempting passkey verification', async () => {
    const service = createService(createStore());
    const malformedResponses: readonly [Record<string, unknown>, string][] = [
      [{}, 'Missing response'],
      [{ response: null }, 'Missing response'],
      [{ response: {} }, 'Missing client data'],
      [
        { response: { clientDataJSON: clientData(null) } },
        'Invalid client data',
      ],
      [
        { response: { clientDataJSON: clientData({ type: 'webauthn.get' }) } },
        'Missing challenge',
      ],
    ];

    for (const [response, message] of malformedResponses) {
      await expect(
        service.verifyRegistration(ACTIVE_SESSION, response),
      ).rejects.toThrow(message);
    }
    expect(verifyRegistrationResponse).not.toHaveBeenCalled();
  });

  it('rejects expired, cross-owner, and cryptographically invalid registration responses', async () => {
    const response = passkeyResponse('registration-challenge');

    const expiredStore = createStore();
    await expect(
      createService(expiredStore).verifyRegistration(ACTIVE_SESSION, response),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });

    const crossOwnerStore = createStore({
      consumeChallenge: vi.fn(async () => ({
        challenge: 'registration-challenge',
        userId: 'different-owner',
      })),
    });
    await expect(
      createService(crossOwnerStore).verifyRegistration(
        ACTIVE_SESSION,
        response,
      ),
    ).rejects.toMatchObject({ code: 'validation_failed', status: 400 });

    const invalidStore = createStore({
      consumeChallenge: vi.fn(async () => ({
        challenge: 'registration-challenge',
        userId: OWNER.id,
      })),
    });
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: false,
    } as never);
    await expect(
      createService(invalidStore).verifyRegistration(ACTIVE_SESSION, response),
    ).rejects.toMatchObject({
      code: 'authentication_required',
      status: 401,
    });
    expect(invalidStore.saveAuthenticator).not.toHaveBeenCalled();
  });

  it('persists a verified registration, rotates the prior session, and issues a fresh one', async () => {
    const store = createStore({
      consumeChallenge: vi.fn(async () => ({
        challenge: 'registration-challenge',
        userId: OWNER.id,
      })),
    });
    vi.mocked(verifyRegistrationResponse).mockResolvedValueOnce({
      verified: true,
      registrationInfo: {
        credential: {
          id: 'new-credential',
          publicKey: Uint8Array.from([1, 2, 3]),
          counter: 0,
        },
      },
    } as never);

    const issued = await createService(store).verifyRegistration(
      ACTIVE_SESSION,
      passkeyResponse('registration-challenge'),
    );

    expect(store.saveAuthenticator).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: OWNER.id,
        credentialId: 'new-credential',
        publicKey: Buffer.from([1, 2, 3]).toString('base64url'),
        counter: 0,
        transports: [],
      }),
      expect.objectContaining({
        now: NOW,
        auditId: expect.any(String),
        correlationId: expect.any(String),
      }),
    );
    expect(store.revokeSession).toHaveBeenCalledWith(
      ACTIVE_SESSION.sessionId,
      NOW,
    );
    expect(store.createSession).toHaveBeenCalledOnce();
    expect(issued).toMatchObject({
      ownerId: OWNER.id,
      displayName: OWNER.displayName,
      expiresAt: new Date('2026-08-30T12:00:00.000Z'),
    });
  });

  it('requires a provisioned owner before issuing authentication options', async () => {
    const store = createStore({ getOwner: vi.fn(async () => undefined) });

    await expect(
      createService(store).authenticationOptions(),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(generateAuthenticationOptions).not.toHaveBeenCalled();
    expect(store.saveChallenge).not.toHaveBeenCalled();
  });

  it('rejects absent credentials, consumed challenges, and cross-owner challenges', async () => {
    const service = createService(createStore());
    await expect(service.loginWithPasskey({})).rejects.toMatchObject({
      code: 'validation_failed',
      status: 400,
    });

    const missingCredential = createStore({
      findAuthenticator: vi.fn(async () => undefined),
      consumeChallenge: vi.fn(async () => ({
        challenge: 'authentication-challenge',
        userId: OWNER.id,
      })),
    });
    await expect(
      createService(missingCredential).loginWithPasskey(
        passkeyResponse('authentication-challenge'),
      ),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });

    const consumedChallenge = createStore();
    await expect(
      createService(consumedChallenge).loginWithPasskey(
        passkeyResponse('authentication-challenge'),
      ),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });

    const crossOwnerChallenge = createStore({
      consumeChallenge: vi.fn(async () => ({
        challenge: 'authentication-challenge',
        userId: 'different-owner',
      })),
    });
    await expect(
      createService(crossOwnerChallenge).loginWithPasskey(
        passkeyResponse('authentication-challenge'),
      ),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(verifyAuthenticationResponse).not.toHaveBeenCalled();
  });

  it('updates the signature counter and rotates the session only after successful verification', async () => {
    const challenge = {
      challenge: 'authentication-challenge',
      userId: OWNER.id,
    };
    const invalidStore = createStore({
      consumeChallenge: vi.fn(async () => challenge),
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: false,
    } as never);
    await expect(
      createService(invalidStore).loginWithPasskey(
        passkeyResponse('authentication-challenge'),
      ),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(invalidStore.updateAuthenticatorCounter).not.toHaveBeenCalled();

    const validStore = createStore({
      consumeChallenge: vi.fn(async () => challenge),
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    } as never);
    const issued = await createService(validStore).loginWithPasskey(
      passkeyResponse('authentication-challenge'),
    );

    expect(verifyAuthenticationResponse).toHaveBeenLastCalledWith(
      expect.objectContaining({
        expectedChallenge: 'authentication-challenge',
        expectedOrigin: 'https://journal.example',
        expectedRPID: 'journal.example',
        credential: expect.objectContaining({
          id: AUTHENTICATOR.credentialId,
          counter: AUTHENTICATOR.counter,
          transports: ['internal'],
        }),
      }),
    );
    expect(validStore.updateAuthenticatorCounter).toHaveBeenCalledWith(
      AUTHENTICATOR.id,
      5,
      NOW,
    );
    expect(validStore.createSession).toHaveBeenCalledOnce();
    expect(issued.ownerId).toBe(OWNER.id);
  });

  it('does not issue a session if the owner disappears after passkey verification', async () => {
    const store = createStore({
      getOwner: vi.fn(async () => undefined),
      consumeChallenge: vi.fn(async () => ({
        challenge: 'authentication-challenge',
        userId: OWNER.id,
      })),
    });
    vi.mocked(verifyAuthenticationResponse).mockResolvedValueOnce({
      verified: true,
      authenticationInfo: { newCounter: 5 },
    } as never);

    await expect(
      createService(store).loginWithPasskey(
        passkeyResponse('authentication-challenge'),
      ),
    ).rejects.toMatchObject({ code: 'authentication_required', status: 401 });
    expect(store.updateAuthenticatorCounter).toHaveBeenCalledOnce();
    expect(store.createSession).not.toHaveBeenCalled();
  });

  it('delegates owner, authenticator-count, logout, and cookie behavior to secure boundaries', async () => {
    const store = createStore();
    const service = createService(store);

    await expect(service.ownerExists()).resolves.toBe(true);
    await expect(service.passkeyCount(OWNER.id)).resolves.toBe(1);
    await expect(service.logout(ACTIVE_SESSION)).resolves.toBeUndefined();

    expect(store.ownerExists).toHaveBeenCalledOnce();
    expect(store.countAuthenticators).toHaveBeenCalledWith(OWNER.id);
    expect(store.revokeOwnedSession).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: ACTIVE_SESSION.ownerId,
        sessionId: ACTIVE_SESSION.sessionId,
        now: NOW,
      }),
    );
    expect(service.csrfCookie('a token=with delimiters')).toBe(
      'journal_csrf=a%20token%3Dwith%20delimiters; Path=/; SameSite=Strict; Secure',
    );
  });

  it('rejects incomplete, unknown, revoked, expired, and CSRF-mismatched sessions', async () => {
    const noCookieRequest = {
      get: vi.fn(() => undefined),
    } as unknown as Request;
    const noSessionStore = createStore();
    const noSessionService = createService(noSessionStore);
    await expect(
      noSessionService.authenticate(noCookieRequest),
    ).resolves.toBeUndefined();

    const tokenOnlyRequest = {
      get: vi.fn((name: string) =>
        name === 'cookie' ? 'journal_session=token' : undefined,
      ),
    } as unknown as Request;
    await expect(
      noSessionService.authenticate(tokenOnlyRequest),
    ).resolves.toBeUndefined();
    expect(noSessionStore.findSession).not.toHaveBeenCalled();

    const request = {
      get: vi.fn((name: string) =>
        name === 'cookie'
          ? 'unrelated=1; journal_session=token; journal_csrf=csrf'
          : undefined,
      ),
    } as unknown as Request;
    await expect(
      noSessionService.authenticate(request),
    ).resolves.toBeUndefined();

    const baseSession = {
      id: ACTIVE_SESSION.sessionId,
      userId: OWNER.id,
      displayName: OWNER.displayName,
      csrfTokenHash: sha256('csrf'),
      createdAt: new Date('2026-08-23T11:00:00.000Z'),
      lastUsedAt: new Date('2026-08-23T11:30:00.000Z'),
      idleExpiresAt: new Date('2026-08-23T12:10:00.000Z'),
      absoluteExpiresAt: new Date('2026-08-23T13:00:00.000Z'),
      revokedAt: null,
    };
    for (const record of [
      { ...baseSession, revokedAt: new Date('2026-08-23T11:00:00.000Z') },
      { ...baseSession, idleExpiresAt: NOW },
      { ...baseSession, absoluteExpiresAt: NOW },
      { ...baseSession, csrfTokenHash: sha256('different-csrf') },
    ]) {
      const store = createStore({ findSession: vi.fn(async () => record) });
      await expect(
        createService(store).authenticate(request),
      ).resolves.toBeUndefined();
      expect(store.touchSession).not.toHaveBeenCalled();
    }
  });
});
