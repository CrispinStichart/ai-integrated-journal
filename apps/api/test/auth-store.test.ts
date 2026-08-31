import type { JournalDatabase } from '@journal/database';
import { describe, expect, it } from 'vitest';

import {
  createPostgresAuthenticationStore,
  sha256,
} from '../src/auth-store.js';

interface FakeDatabase {
  database: JournalDatabase;
  outcomes: unknown[];
  transactionError?: unknown;
  calls: string[];
}

function fakeDatabase(): FakeDatabase {
  const outcomes: unknown[] = [];
  const calls: string[] = [];
  let transactionError: unknown;
  const chainTarget = {
    then(resolve: (value: unknown) => void, reject: (reason: unknown) => void) {
      const outcome = outcomes.shift() ?? [];
      if (outcome instanceof Error) reject(outcome);
      else resolve(outcome);
    },
  };
  const chain = new Proxy(chainTarget, {
    get(target, property) {
      if (property === 'then') return target.then;
      return () => {
        calls.push(String(property));
        return chain;
      };
    },
  });
  const database = new Proxy(
    {},
    {
      get(_target, property) {
        if (property === 'transaction') {
          return async (work: (transaction: unknown) => Promise<unknown>) => {
            if (transactionError !== undefined) throw transactionError;
            return work(chain);
          };
        }
        return () => {
          calls.push(String(property));
          return chain;
        };
      },
    },
  ) as JournalDatabase;
  return {
    database,
    outcomes,
    calls,
    get transactionError() {
      return transactionError;
    },
    set transactionError(value: unknown) {
      transactionError = value;
    },
  };
}

describe('PostgreSQL authentication store (SEC-002)', () => {
  it('uses deterministic one-way SHA-256 token lookup values', () => {
    expect(sha256('secret')).toBe(sha256('secret'));
    expect(sha256('secret')).not.toBe('secret');
  });

  it('creates an owner transactionally and handles the singleton race', async () => {
    const fake = fakeDatabase();
    const store = createPostgresAuthenticationStore(fake.database);
    const owner = {
      id: '019c5b90-0000-7000-8000-000000000001',
      displayName: 'Owner',
      journalTimeZone: 'UTC',
      passwordHash: 'hash',
      recoveryCodes: [
        { id: '019c5b90-0000-7000-8000-000000000002', hash: 'code-hash' },
      ],
      auditId: '019c5b90-0000-7000-8000-000000000003',
      correlationId: '019c5b90-0000-7000-8000-000000000004',
    };

    await expect(store.createOwner(owner)).resolves.toBe(true);
    fake.transactionError = Object.assign(new Error('duplicate'), {
      code: '23505',
    });
    await expect(store.createOwner(owner)).resolves.toBe(false);
    fake.transactionError = new Error('database unavailable');
    await expect(store.createOwner(owner)).rejects.toThrow(
      'database unavailable',
    );
  });

  it('reads owner, session, authenticator, and challenge records', async () => {
    const fake = fakeDatabase();
    const store = createPostgresAuthenticationStore(fake.database);
    const owner = { id: 'owner', displayName: 'Owner', passwordHash: 'hash' };
    const session = {
      id: 'session',
      userId: 'owner',
      displayName: 'Owner',
      csrfTokenHash: 'csrf',
      idleExpiresAt: new Date('2026-08-16T12:01:00Z'),
      absoluteExpiresAt: new Date('2026-08-17T12:00:00Z'),
      revokedAt: null,
    };
    const authenticator = {
      id: 'authenticator',
      userId: 'owner',
      credentialId: 'credential',
      publicKey: 'key',
      counter: 0,
      transports: ['internal'],
    };
    fake.outcomes.push(
      [{ id: 'owner' }],
      [owner],
      [session],
      [{ id: 'one' }],
      [authenticator],
      [authenticator],
    );

    await expect(store.ownerExists()).resolves.toBe(true);
    await expect(store.getOwner()).resolves.toEqual(owner);
    await expect(store.findSession('token-hash')).resolves.toEqual(session);
    await expect(store.countAuthenticators('owner')).resolves.toBe(1);
    await expect(store.listAuthenticators('owner')).resolves.toEqual([
      authenticator,
    ]);
    await expect(store.findAuthenticator('credential')).resolves.toEqual(
      authenticator,
    );

    fake.outcomes.push([], [], []);
    await expect(store.getOwner()).resolves.toBeUndefined();
    await expect(store.findSession('missing')).resolves.toBeUndefined();
    await expect(store.findAuthenticator('missing')).resolves.toBeUndefined();
  });

  it('[SEC-002][SEC-008] recovers credentials, sessions, codes, and the content-free audit atomically', async () => {
    const fake = fakeDatabase();
    const store = createPostgresAuthenticationStore(fake.database);
    const now = new Date('2026-08-16T12:00:00Z');
    fake.outcomes.push(
      [{ userId: 'owner' }],
      [{ id: 'owner', displayName: 'Owner' }],
    );
    await expect(
      store.recoverOwner({
        codeHash: 'code',
        passwordHash: 'new-hash',
        recoveryCodes: [{ id: 'code-id', hash: 'hash' }],
        now,
        auditId: 'audit',
        correlationId: 'correlation',
      }),
    ).resolves.toEqual({
      id: 'owner',
      displayName: 'Owner',
      passwordHash: 'new-hash',
    });
    fake.outcomes.push([]);
    await expect(
      store.recoverOwner({
        codeHash: 'missing',
        passwordHash: 'unused-hash',
        recoveryCodes: [{ id: 'unused-code-id', hash: 'unused-hash' }],
        now,
        auditId: 'unused-audit',
        correlationId: 'unused-correlation',
      }),
    ).resolves.toBeUndefined();

    expect(fake.calls).toContain('insert');
    expect(fake.calls).toContain('update');
    expect(fake.calls).toContain('delete');
  });

  it('executes session and authenticator mutations', async () => {
    const fake = fakeDatabase();
    const store = createPostgresAuthenticationStore(fake.database);
    const now = new Date('2026-08-16T12:00:00Z');
    await store.createSession({
      id: 'session',
      userId: 'owner',
      tokenHash: 'token',
      csrfTokenHash: 'csrf',
      now,
      idleExpiresAt: new Date(now.getTime() + 1000),
      absoluteExpiresAt: new Date(now.getTime() + 2000),
    });
    await store.touchSession('session', now, new Date(now.getTime() + 500));
    await store.revokeSession('session', now);
    await store.saveAuthenticator(
      {
        id: 'authenticator',
        userId: 'owner',
        credentialId: 'credential',
        publicKey: 'key',
        counter: 0,
        transports: ['internal'],
      },
      { now, auditId: 'audit', correlationId: 'correlation' },
    );
    await store.updateAuthenticatorCounter('authenticator', 1, now);
    await store.saveChallenge({
      id: 'challenge',
      userId: 'owner',
      purpose: 'passkey_registration',
      challenge: 'value',
      challengeHash: 'hash',
      expiresAt: new Date(now.getTime() + 1000),
    });

    expect(fake.calls).toContain('insert');
    expect(fake.calls).toContain('update');
  });

  it('atomically consumes valid challenges and omits nullable owners', async () => {
    const fake = fakeDatabase();
    const store = createPostgresAuthenticationStore(fake.database);
    const now = new Date('2026-08-16T12:00:00Z');
    fake.outcomes.push(
      [{ challenge: 'one', userId: 'owner' }],
      [{ challenge: 'two', userId: null }],
      [],
    );

    await expect(
      store.consumeChallenge('one', 'passkey_registration', now),
    ).resolves.toEqual({ challenge: 'one', userId: 'owner' });
    await expect(
      store.consumeChallenge('two', 'passkey_authentication', now),
    ).resolves.toEqual({ challenge: 'two' });
    await expect(
      store.consumeChallenge('missing', 'passkey_authentication', now),
    ).resolves.toBeUndefined();
  });
});
