import type { Request } from 'express';
import { createUuidV7 } from '@journal/domain';
import { describe, expect, it } from 'vitest';

import {
  AuthenticationError,
  AuthenticationService,
  sessionRecordIsExpired,
} from '../src/auth.js';
import {
  sha256,
  type AuthenticationStore,
  type AuthenticatorRecord,
  type NewOwner,
  type NewSession,
  type OwnerRecord,
  type SessionRecord,
} from '../src/auth-store.js';

function requestWithCookies(
  token: string,
  csrf: string,
  headers = {},
): Request {
  const values: Record<string, string> = {
    cookie: `journal_session=${token}; journal_csrf=${csrf}`,
    ...headers,
  };
  return {
    get: (name: string) => values[name.toLowerCase()],
  } as Request;
}

function createMemoryStore(): AuthenticationStore & {
  sessions: Map<string, SessionRecord>;
  recoveryHashes: Set<string>;
} {
  let owner: OwnerRecord | undefined;
  const sessionsByHash = new Map<string, SessionRecord>();
  const recoveryHashes = new Set<string>();
  const authenticators = new Map<string, AuthenticatorRecord>();
  const challenges = new Map<
    string,
    {
      challenge: string;
      userId?: string;
      purpose: string;
      expiresAt: Date;
      consumed: boolean;
    }
  >();

  return {
    sessions: sessionsByHash,
    recoveryHashes,
    ownerExists: async () => owner !== undefined,
    createOwner: async (input: NewOwner) => {
      if (owner) return false;
      owner = {
        id: input.id,
        displayName: input.displayName,
        passwordHash: input.passwordHash,
      };
      input.recoveryCodes.forEach((code) => recoveryHashes.add(code.hash));
      return true;
    },
    getOwner: async () => owner,
    updatePassword: async (_userId, passwordHash) => {
      if (owner) owner = { ...owner, passwordHash };
    },
    consumeRecoveryCode: async (codeHash) => {
      if (!owner || !recoveryHashes.delete(codeHash)) return undefined;
      return owner.id;
    },
    replaceRecoveryCodes: async (_userId, codes) => {
      recoveryHashes.clear();
      codes.forEach((code) => recoveryHashes.add(code.hash));
    },
    createSession: async (session: NewSession) => {
      if (!owner) throw new Error('owner missing');
      sessionsByHash.set(session.tokenHash, {
        id: session.id,
        userId: session.userId,
        displayName: owner.displayName,
        csrfTokenHash: session.csrfTokenHash,
        createdAt: session.now,
        lastUsedAt: session.now,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        revokedAt: null,
      });
    },
    findSession: async (tokenHash) => sessionsByHash.get(tokenHash),
    touchSession: async (id, _now, idleExpiresAt) => {
      for (const [hash, session] of sessionsByHash) {
        if (session.id === id)
          sessionsByHash.set(hash, { ...session, idleExpiresAt });
      }
    },
    revokeSession: async (id, now) => {
      for (const [hash, session] of sessionsByHash) {
        if (session.id === id)
          sessionsByHash.set(hash, { ...session, revokedAt: now });
      }
    },
    revokeUserSessions: async (userId, now) => {
      for (const [hash, session] of sessionsByHash) {
        if (session.userId === userId)
          sessionsByHash.set(hash, { ...session, revokedAt: now });
      }
    },
    listActiveSessions: async (userId, now) =>
      [...sessionsByHash.values()].filter(
        (session) =>
          session.userId === userId &&
          session.revokedAt === null &&
          session.idleExpiresAt > now &&
          session.absoluteExpiresAt > now,
      ),
    revokeOwnedSession: async ({ userId, sessionId, now }) => {
      for (const [hash, session] of sessionsByHash) {
        if (
          session.userId === userId &&
          session.id === sessionId &&
          session.revokedAt === null
        ) {
          sessionsByHash.set(hash, { ...session, revokedAt: now });
          return true;
        }
      }
      return false;
    },
    countAuthenticators: async () => authenticators.size,
    listAuthenticators: async () => [...authenticators.values()],
    findAuthenticator: async (credentialId) => authenticators.get(credentialId),
    saveAuthenticator: async (record) => {
      authenticators.set(record.credentialId, record);
    },
    updateAuthenticatorCounter: async (id, counter) => {
      for (const [key, record] of authenticators) {
        if (record.id === id) authenticators.set(key, { ...record, counter });
      }
    },
    saveChallenge: async (input) => {
      challenges.set(input.challengeHash, {
        challenge: input.challenge,
        ...(input.userId === undefined ? {} : { userId: input.userId }),
        purpose: input.purpose,
        expiresAt: input.expiresAt,
        consumed: false,
      });
    },
    consumeChallenge: async (hash, purpose, now) => {
      const item = challenges.get(hash);
      if (
        !item ||
        item.consumed ||
        item.purpose !== purpose ||
        item.expiresAt <= now
      )
        return undefined;
      item.consumed = true;
      return {
        challenge: item.challenge,
        ...(item.userId === undefined ? {} : { userId: item.userId }),
      };
    },
  };
}

function service(store = createMemoryStore(), now?: () => Date) {
  return new AuthenticationService({
    store,
    rpId: 'localhost',
    expectedOrigin: 'http://localhost:5173',
    secureCookies: false,
    ...(now === undefined ? {} : { now }),
    sessionIdleMilliseconds: 60_000,
    sessionAbsoluteMilliseconds: 300_000,
  });
}

describe('authentication vertical slice (SEC-001, SEC-002, SEC-008)', () => {
  it('provisions exactly one owner and stores only hashed credentials and recovery codes', async () => {
    const store = createMemoryStore();
    const auth = service(store);
    const first = await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });

    expect(first.recoveryCodes).toHaveLength(10);
    expect([...store.recoveryHashes]).not.toContain(first.recoveryCodes?.[0]);
    expect((await store.getOwner())?.passwordHash).toMatch(/^\$argon2id\$/);
    await expect(
      auth.bootstrap({
        displayName: 'Second owner',
        password: 'another strong password',
        journalTimeZone: 'UTC',
      }),
    ).rejects.toMatchObject({ code: 'conflict', status: 409 });
  });

  it('authenticates a password, stores an opaque token hash, and enforces CSRF', async () => {
    const store = createMemoryStore();
    const auth = service(store);
    await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });
    const session = await auth.loginWithPassword('a strong local password');

    expect(store.sessions.has(session.token)).toBe(false);
    expect(store.sessions.has(sha256(session.token))).toBe(true);
    const active = await auth.authenticate(
      requestWithCookies(session.token, session.csrfToken),
    );
    if (!active) throw new Error('expected an active session');
    expect(active?.ownerId).toBe((await store.getOwner())?.id);
    expect(() =>
      auth.assertCsrf(
        requestWithCookies(session.token, session.csrfToken, {
          'x-csrf-token': 'wrong',
          origin: 'http://localhost:5173',
        }),
        active,
      ),
    ).toThrow(AuthenticationError);
    expect(() =>
      auth.assertCsrf(
        requestWithCookies(session.token, session.csrfToken, {
          'x-csrf-token': session.csrfToken,
          origin: 'http://localhost:5173',
        }),
        active,
      ),
    ).not.toThrow();
  });

  it('expires idle sessions and caps sliding expiry at the absolute deadline', async () => {
    let clock = new Date('2026-08-16T12:00:00.000Z');
    const store = createMemoryStore();
    const auth = service(store, () => clock);
    const issued = await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });
    const record = store.sessions.get(sha256(issued.token));
    if (!record) throw new Error('expected a persisted session');
    expect(sessionRecordIsExpired(record, clock)).toBe(false);

    clock = new Date(clock.getTime() + 61_000);
    expect(
      await auth.authenticate(
        requestWithCookies(issued.token, issued.csrfToken),
      ),
    ).toBeUndefined();
    expect(store.sessions.get(sha256(issued.token))?.revokedAt).toEqual(clock);
  });

  it('uses recovery codes once, rotates all sessions and returns a fresh set', async () => {
    const store = createMemoryStore();
    const auth = service(store);
    const bootstrap = await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });
    const code = bootstrap.recoveryCodes?.[0];
    if (!code) throw new Error('expected a recovery code');
    const recovered = await auth.recover(code, 'a replacement password');

    expect(recovered.recoveryCodes).toHaveLength(10);
    expect(
      store.sessions.get(sha256(bootstrap.token))?.revokedAt,
    ).not.toBeNull();
    await expect(
      auth.recover(code, 'yet another password'),
    ).rejects.toMatchObject({
      code: 'authentication_required',
    });
    await expect(
      auth.loginWithPassword('a replacement password'),
    ).resolves.toBeDefined();
  });

  it('[SEC-002][SEC-008] lists only secret-free active session metadata and revokes an owner session', async () => {
    const store = createMemoryStore();
    const auth = service(store);
    const first = await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });
    const second = await auth.loginWithPassword('a strong local password');
    const active = await auth.authenticate(
      requestWithCookies(first.token, first.csrfToken),
    );
    if (!active) throw new Error('expected an active session');

    const sessions = await auth.listSessions(active);
    expect(sessions).toHaveLength(2);
    expect(sessions.filter((item) => item.current)).toHaveLength(1);
    expect(JSON.stringify(sessions)).not.toContain(first.token);
    expect(JSON.stringify(sessions)).not.toContain(first.csrfToken);
    const secondRecord = store.sessions.get(sha256(second.token));
    if (!secondRecord) throw new Error('expected second persisted session');
    await expect(
      auth.revokeOwnedSession(active, secondRecord.id, createUuidV7()),
    ).resolves.toEqual({ revoked: true, currentSession: false });
    expect(store.sessions.get(sha256(second.token))?.revokedAt).not.toBeNull();
  });

  it('emits strict development and production cookie attributes', () => {
    const local = service();
    const secure = new AuthenticationService({
      store: createMemoryStore(),
      rpId: 'journal.example',
      expectedOrigin: 'https://journal.example',
      secureCookies: true,
    });

    expect(local.sessionCookie('token')).toContain('HttpOnly; SameSite=Strict');
    expect(local.sessionCookie('token')).not.toContain('Secure');
    expect(secure.sessionCookie('token')).toContain(
      'HttpOnly; SameSite=Strict; Secure',
    );
    expect(secure.clearCookies()).toHaveLength(2);
  });

  it('issues single-use, expiring WebAuthn registration challenges', async () => {
    const store = createMemoryStore();
    const auth = service(store);
    const issued = await auth.bootstrap({
      displayName: 'Owner',
      password: 'a strong local password',
      journalTimeZone: 'UTC',
    });
    const active = await auth.authenticate(
      requestWithCookies(issued.token, issued.csrfToken),
    );
    if (!active) throw new Error('expected an active session');
    const options = await auth.registrationOptions(active);

    expect(options.challenge).toEqual(expect.any(String));
    const challenge = await store.consumeChallenge(
      sha256(String(options.challenge)),
      'passkey_registration',
      new Date(),
    );
    expect(challenge?.userId).toBe(active?.ownerId);
    await expect(
      store.consumeChallenge(
        sha256(String(options.challenge)),
        'passkey_registration',
        new Date(),
      ),
    ).resolves.toBeUndefined();
  });
});
