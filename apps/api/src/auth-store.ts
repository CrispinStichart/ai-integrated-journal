import { createHash } from 'node:crypto';

import {
  authChallenges,
  auditEvents,
  authenticators,
  passwordCredentials,
  recoveryCodes,
  sessions,
  users,
  type JournalDatabase,
} from '@journal/database';
import { and, eq, gt, isNull } from 'drizzle-orm';

export interface OwnerRecord {
  readonly id: string;
  readonly displayName: string;
  readonly passwordHash: string;
}

export interface SessionRecord {
  readonly id: string;
  readonly userId: string;
  readonly displayName: string;
  readonly csrfTokenHash: string;
  readonly createdAt: Date;
  readonly lastUsedAt: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface AuthenticatorRecord {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  readonly publicKey: string;
  readonly counter: number;
  readonly transports: readonly string[];
}

export interface NewOwner {
  readonly id: string;
  readonly displayName: string;
  readonly journalTimeZone: string;
  readonly passwordHash: string;
  readonly recoveryCodes: readonly { id: string; hash: string }[];
}

export interface NewSession {
  readonly id: string;
  readonly userId: string;
  readonly tokenHash: string;
  readonly csrfTokenHash: string;
  readonly now: Date;
  readonly idleExpiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

export type ChallengePurpose =
  'passkey_registration' | 'passkey_authentication';

export interface AuthenticationStore {
  ownerExists(): Promise<boolean>;
  createOwner(owner: NewOwner): Promise<boolean>;
  getOwner(): Promise<OwnerRecord | undefined>;
  updatePassword(
    userId: string,
    passwordHash: string,
    now: Date,
  ): Promise<void>;
  consumeRecoveryCode(codeHash: string, now: Date): Promise<string | undefined>;
  replaceRecoveryCodes(
    userId: string,
    codes: readonly { id: string; hash: string }[],
  ): Promise<void>;
  createSession(session: NewSession): Promise<void>;
  findSession(tokenHash: string): Promise<SessionRecord | undefined>;
  touchSession(id: string, now: Date, idleExpiresAt: Date): Promise<void>;
  revokeSession(id: string, now: Date): Promise<void>;
  revokeUserSessions(userId: string, now: Date): Promise<void>;
  listActiveSessions(
    userId: string,
    now: Date,
  ): Promise<readonly SessionRecord[]>;
  revokeOwnedSession(input: {
    userId: string;
    sessionId: string;
    now: Date;
    auditId: string;
    correlationId: string;
  }): Promise<boolean>;
  countAuthenticators(userId: string): Promise<number>;
  listAuthenticators(userId: string): Promise<readonly AuthenticatorRecord[]>;
  findAuthenticator(
    credentialId: string,
  ): Promise<AuthenticatorRecord | undefined>;
  saveAuthenticator(record: AuthenticatorRecord): Promise<void>;
  updateAuthenticatorCounter(
    id: string,
    counter: number,
    now: Date,
  ): Promise<void>;
  saveChallenge(input: {
    id: string;
    userId?: string;
    purpose: ChallengePurpose;
    challenge: string;
    challengeHash: string;
    expiresAt: Date;
  }): Promise<void>;
  consumeChallenge(
    challengeHash: string,
    purpose: ChallengePurpose,
    now: Date,
  ): Promise<{ challenge: string; userId?: string } | undefined>;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505'
  );
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function createPostgresAuthenticationStore(
  database: JournalDatabase,
): AuthenticationStore {
  return {
    async ownerExists() {
      return (
        (await database.select({ id: users.id }).from(users).limit(1)).length >
        0
      );
    },
    async createOwner(owner) {
      try {
        await database.transaction(async (transaction) => {
          await transaction.insert(users).values({
            id: owner.id,
            displayName: owner.displayName,
            journalTimeZone: owner.journalTimeZone,
          });
          await transaction.insert(passwordCredentials).values({
            userId: owner.id,
            passwordHash: owner.passwordHash,
          });
          await transaction.insert(recoveryCodes).values(
            owner.recoveryCodes.map((code) => ({
              id: code.id,
              userId: owner.id,
              codeHash: code.hash,
            })),
          );
        });
        return true;
      } catch (error) {
        if (isUniqueViolation(error)) return false;
        throw error;
      }
    },
    async getOwner() {
      const [owner] = await database
        .select({
          id: users.id,
          displayName: users.displayName,
          passwordHash: passwordCredentials.passwordHash,
        })
        .from(users)
        .innerJoin(
          passwordCredentials,
          eq(passwordCredentials.userId, users.id),
        )
        .limit(1);
      return owner;
    },
    async updatePassword(userId, passwordHash, now) {
      await database
        .update(passwordCredentials)
        .set({ passwordHash, updatedAt: now })
        .where(eq(passwordCredentials.userId, userId));
    },
    async consumeRecoveryCode(codeHash, now) {
      const [used] = await database
        .update(recoveryCodes)
        .set({ usedAt: now })
        .where(
          and(
            eq(recoveryCodes.codeHash, codeHash),
            isNull(recoveryCodes.usedAt),
          ),
        )
        .returning({ userId: recoveryCodes.userId });
      return used?.userId;
    },
    async replaceRecoveryCodes(userId, codes) {
      await database.transaction(async (transaction) => {
        await transaction
          .delete(recoveryCodes)
          .where(eq(recoveryCodes.userId, userId));
        await transaction
          .insert(recoveryCodes)
          .values(
            codes.map((code) => ({ id: code.id, userId, codeHash: code.hash })),
          );
      });
    },
    async createSession(session) {
      await database.insert(sessions).values({
        id: session.id,
        userId: session.userId,
        tokenHash: session.tokenHash,
        csrfTokenHash: session.csrfTokenHash,
        createdAt: session.now,
        lastUsedAt: session.now,
        idleExpiresAt: session.idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
      });
    },
    async findSession(tokenHash) {
      const [session] = await database
        .select({
          id: sessions.id,
          userId: sessions.userId,
          displayName: users.displayName,
          csrfTokenHash: sessions.csrfTokenHash,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          idleExpiresAt: sessions.idleExpiresAt,
          absoluteExpiresAt: sessions.absoluteExpiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(eq(sessions.tokenHash, tokenHash))
        .limit(1);
      return session;
    },
    async touchSession(id, now, idleExpiresAt) {
      await database
        .update(sessions)
        .set({ lastUsedAt: now, idleExpiresAt })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
    },
    async revokeSession(id, now) {
      await database
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.id, id), isNull(sessions.revokedAt)));
    },
    async revokeUserSessions(userId, now) {
      await database
        .update(sessions)
        .set({ revokedAt: now })
        .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)));
    },
    async listActiveSessions(userId, now) {
      return database
        .select({
          id: sessions.id,
          userId: sessions.userId,
          displayName: users.displayName,
          csrfTokenHash: sessions.csrfTokenHash,
          createdAt: sessions.createdAt,
          lastUsedAt: sessions.lastUsedAt,
          idleExpiresAt: sessions.idleExpiresAt,
          absoluteExpiresAt: sessions.absoluteExpiresAt,
          revokedAt: sessions.revokedAt,
        })
        .from(sessions)
        .innerJoin(users, eq(users.id, sessions.userId))
        .where(
          and(
            eq(sessions.userId, userId),
            isNull(sessions.revokedAt),
            gt(sessions.idleExpiresAt, now),
            gt(sessions.absoluteExpiresAt, now),
          ),
        );
    },
    async revokeOwnedSession(input) {
      return database.transaction(async (transaction) => {
        const [revoked] = await transaction
          .update(sessions)
          .set({ revokedAt: input.now })
          .where(
            and(
              eq(sessions.id, input.sessionId),
              eq(sessions.userId, input.userId),
              isNull(sessions.revokedAt),
            ),
          )
          .returning({ id: sessions.id });
        if (revoked === undefined) return false;
        await transaction.insert(auditEvents).values({
          id: input.auditId,
          action: 'auth.session_revoked',
          actorId: input.userId,
          entityType: 'session',
          entityId: input.sessionId,
          correlationId: input.correlationId,
          metadata: {},
          occurredAt: input.now,
        });
        return true;
      });
    },
    async countAuthenticators(userId) {
      return (
        await database
          .select({ id: authenticators.id })
          .from(authenticators)
          .where(eq(authenticators.userId, userId))
      ).length;
    },
    async listAuthenticators(userId) {
      return database
        .select({
          id: authenticators.id,
          userId: authenticators.userId,
          credentialId: authenticators.credentialId,
          publicKey: authenticators.publicKey,
          counter: authenticators.counter,
          transports: authenticators.transports,
        })
        .from(authenticators)
        .where(eq(authenticators.userId, userId));
    },
    async findAuthenticator(credentialId) {
      const [record] = await database
        .select({
          id: authenticators.id,
          userId: authenticators.userId,
          credentialId: authenticators.credentialId,
          publicKey: authenticators.publicKey,
          counter: authenticators.counter,
          transports: authenticators.transports,
        })
        .from(authenticators)
        .where(eq(authenticators.credentialId, credentialId))
        .limit(1);
      return record;
    },
    async saveAuthenticator(record) {
      await database.insert(authenticators).values({
        id: record.id,
        userId: record.userId,
        credentialId: record.credentialId,
        publicKey: record.publicKey,
        counter: record.counter,
        transports: [...record.transports],
      });
    },
    async updateAuthenticatorCounter(id, counter, now) {
      await database
        .update(authenticators)
        .set({ counter, lastUsedAt: now })
        .where(eq(authenticators.id, id));
    },
    async saveChallenge(input) {
      await database.insert(authChallenges).values(input);
    },
    async consumeChallenge(challengeHash, purpose, now) {
      const [challenge] = await database
        .update(authChallenges)
        .set({ consumedAt: now })
        .where(
          and(
            eq(authChallenges.challengeHash, challengeHash),
            eq(authChallenges.purpose, purpose),
            isNull(authChallenges.consumedAt),
            gt(authChallenges.expiresAt, now),
          ),
        )
        .returning({
          challenge: authChallenges.challenge,
          userId: authChallenges.userId,
        });
      if (!challenge) return undefined;
      return {
        challenge: challenge.challenge,
        ...(challenge.userId === null ? {} : { userId: challenge.userId }),
      };
    },
  };
}
