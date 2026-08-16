import { randomBytes, timingSafeEqual } from 'node:crypto';

import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { createUuidV7 } from '@journal/domain';
import argon2 from 'argon2';
import type { Request } from 'express';

import {
  sha256,
  type AuthenticationStore,
  type SessionRecord,
} from './auth-store.js';
import type { AuthenticatedPrincipal, RequestAuthenticator } from './types.js';

const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const RECOVERY_CODE_COUNT = 10;
const SESSION_COOKIE = 'journal_session';
const CSRF_COOKIE = 'journal_csrf';

export interface AuthenticationOptions {
  readonly store: AuthenticationStore;
  readonly rpId: string;
  readonly expectedOrigin: string;
  readonly secureCookies: boolean;
  readonly now?: () => Date;
  readonly sessionIdleMilliseconds?: number;
  readonly sessionAbsoluteMilliseconds?: number;
}

export interface IssuedSession {
  readonly token: string;
  readonly csrfToken: string;
  readonly displayName: string;
  readonly expiresAt: Date;
  readonly recoveryCodes?: readonly string[];
}

export interface ActiveSession extends AuthenticatedPrincipal {
  readonly sessionId: string;
  readonly displayName: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

export class AuthenticationError extends Error {
  constructor(
    readonly code:
      | 'authentication_required'
      | 'forbidden'
      | 'conflict'
      | 'validation_failed',
    readonly status: 400 | 401 | 403 | 409,
    message: string,
  ) {
    super(message);
    this.name = 'AuthenticationError';
  }
}

function cookie(request: Request, name: string): string | undefined {
  const header = request.get('cookie');
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return decodeURIComponent(value.join('='));
  }
  return undefined;
}

function opaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

function recoveryCode(): string {
  const bytes = randomBytes(20);
  const value = [...bytes]
    .map((byte) => RECOVERY_ALPHABET[byte % RECOVERY_ALPHABET.length])
    .join('');
  return value.match(/.{5}/g)?.join('-') ?? value;
}

function safeHashEquals(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(sha256(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function challengeFromResponse(response: Record<string, unknown>): string {
  const nested = response.response;
  if (typeof nested !== 'object' || nested === null)
    throw new Error('Missing response');
  const encoded = (nested as Record<string, unknown>).clientDataJSON;
  if (typeof encoded !== 'string') throw new Error('Missing client data');
  const decoded: unknown = JSON.parse(
    Buffer.from(encoded, 'base64url').toString('utf8'),
  );
  if (typeof decoded !== 'object' || decoded === null)
    throw new Error('Invalid client data');
  const challenge = (decoded as Record<string, unknown>).challenge;
  if (typeof challenge !== 'string') throw new Error('Missing challenge');
  return challenge;
}

export class AuthenticationService implements RequestAuthenticator {
  readonly #store: AuthenticationStore;
  readonly #rpId: string;
  readonly #expectedOrigin: string;
  readonly #now: () => Date;
  readonly #idle: number;
  readonly #absolute: number;
  readonly secureCookies: boolean;

  constructor(options: AuthenticationOptions) {
    this.#store = options.store;
    this.#rpId = options.rpId;
    this.#expectedOrigin = options.expectedOrigin;
    this.secureCookies = options.secureCookies;
    this.#now = options.now ?? (() => new Date());
    this.#idle = options.sessionIdleMilliseconds ?? 30 * 60 * 1000;
    this.#absolute =
      options.sessionAbsoluteMilliseconds ?? 7 * 24 * 60 * 60 * 1000;
  }

  ownerExists(): Promise<boolean> {
    return this.#store.ownerExists();
  }

  async authenticate(request: Request): Promise<ActiveSession | undefined> {
    const token = cookie(request, SESSION_COOKIE);
    const csrfToken = cookie(request, CSRF_COOKIE);
    if (!token || !csrfToken) return undefined;
    const record = await this.#store.findSession(sha256(token));
    if (!record) return undefined;
    const now = this.#now();
    if (
      record.revokedAt !== null ||
      record.idleExpiresAt <= now ||
      record.absoluteExpiresAt <= now ||
      !safeHashEquals(csrfToken, record.csrfTokenHash)
    ) {
      if (record.revokedAt === null)
        await this.#store.revokeSession(record.id, now);
      return undefined;
    }
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + this.#idle, record.absoluteExpiresAt.getTime()),
    );
    await this.#store.touchSession(record.id, now, idleExpiresAt);
    return {
      ownerId: record.userId,
      sessionId: record.id,
      displayName: record.displayName,
      csrfToken,
      expiresAt: record.absoluteExpiresAt,
    };
  }

  assertCsrf(request: Request, session: ActiveSession): void {
    const supplied = request.get('x-csrf-token');
    const origin = request.get('origin');
    if (
      !supplied ||
      supplied !== session.csrfToken ||
      (origin !== undefined && origin !== this.#expectedOrigin)
    ) {
      throw new AuthenticationError('forbidden', 403, 'CSRF validation failed');
    }
  }

  async bootstrap(input: {
    displayName: string;
    password: string;
    journalTimeZone: string;
  }): Promise<IssuedSession> {
    const passwordHash = await this.#hashPassword(input.password);
    const codes = this.#newRecoveryCodes();
    const ownerId = createUuidV7<'owner'>();
    const created = await this.#store.createOwner({
      id: ownerId,
      displayName: input.displayName,
      journalTimeZone: input.journalTimeZone,
      passwordHash,
      recoveryCodes: codes.map((code) => ({
        id: createUuidV7<'recovery-code'>(),
        hash: sha256(code),
      })),
    });
    if (!created)
      throw new AuthenticationError(
        'conflict',
        409,
        'Owner already provisioned',
      );
    return this.#issueSession(ownerId, input.displayName, codes);
  }

  async loginWithPassword(password: string): Promise<IssuedSession> {
    const owner = await this.#store.getOwner();
    if (!owner || !(await argon2.verify(owner.passwordHash, password))) {
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Invalid credentials',
      );
    }
    return this.#issueSession(owner.id, owner.displayName);
  }

  async recover(
    recoveryCodeValue: string,
    newPassword: string,
  ): Promise<IssuedSession> {
    const now = this.#now();
    const ownerId = await this.#store.consumeRecoveryCode(
      sha256(recoveryCodeValue.toUpperCase()),
      now,
    );
    const owner = await this.#store.getOwner();
    if (!ownerId || !owner || owner.id !== ownerId) {
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Invalid recovery code',
      );
    }
    const passwordHash = await this.#hashPassword(newPassword);
    const codes = this.#newRecoveryCodes();
    await this.#store.updatePassword(ownerId, passwordHash, now);
    await this.#store.replaceRecoveryCodes(
      ownerId,
      codes.map((code) => ({
        id: createUuidV7<'recovery-code'>(),
        hash: sha256(code),
      })),
    );
    await this.#store.revokeUserSessions(ownerId, now);
    return this.#issueSession(ownerId, owner.displayName, codes);
  }

  async logout(session: ActiveSession): Promise<void> {
    await this.#store.revokeSession(session.sessionId, this.#now());
  }

  async registrationOptions(
    session: ActiveSession,
  ): Promise<Record<string, unknown>> {
    const existing = await this.#store.listAuthenticators(session.ownerId);
    const options = await generateRegistrationOptions({
      rpName: 'AI-Integrated Journal',
      rpID: this.#rpId,
      userID: Buffer.from(session.ownerId),
      userName: session.displayName,
      userDisplayName: session.displayName,
      attestationType: 'none',
      authenticatorSelection: {
        residentKey: 'preferred',
        userVerification: 'required',
      },
      excludeCredentials: existing.map((item) => ({
        id: item.credentialId,
        transports: item.transports as AuthenticatorTransportFuture[],
      })),
    });
    await this.#saveChallenge(
      options.challenge,
      session.ownerId,
      'passkey_registration',
    );
    return options as unknown as Record<string, unknown>;
  }

  async verifyRegistration(
    session: ActiveSession,
    response: Record<string, unknown>,
  ): Promise<IssuedSession> {
    const challenge = challengeFromResponse(response);
    const stored = await this.#store.consumeChallenge(
      sha256(challenge),
      'passkey_registration',
      this.#now(),
    );
    if (!stored || stored.userId !== session.ownerId) {
      throw new AuthenticationError(
        'validation_failed',
        400,
        'Passkey challenge expired',
      );
    }
    const verification = await verifyRegistrationResponse({
      response: response as unknown as RegistrationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.#expectedOrigin,
      expectedRPID: this.#rpId,
      requireUserVerification: true,
    });
    if (!verification.verified) {
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Passkey verification failed',
      );
    }
    const credential = verification.registrationInfo.credential;
    await this.#store.saveAuthenticator({
      id: createUuidV7<'authenticator'>(),
      userId: session.ownerId,
      credentialId: credential.id,
      publicKey: Buffer.from(credential.publicKey).toString('base64url'),
      counter: credential.counter,
      transports: credential.transports ?? [],
    });
    await this.#store.revokeSession(session.sessionId, this.#now());
    return this.#issueSession(session.ownerId, session.displayName);
  }

  async authenticationOptions(): Promise<Record<string, unknown>> {
    const owner = await this.#store.getOwner();
    if (!owner)
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Owner not provisioned',
      );
    const credentials = await this.#store.listAuthenticators(owner.id);
    const options = await generateAuthenticationOptions({
      rpID: this.#rpId,
      userVerification: 'required',
      allowCredentials: credentials.map((item) => ({
        id: item.credentialId,
        transports: item.transports as AuthenticatorTransportFuture[],
      })),
    });
    await this.#saveChallenge(
      options.challenge,
      owner.id,
      'passkey_authentication',
    );
    return options as unknown as Record<string, unknown>;
  }

  async loginWithPasskey(
    response: Record<string, unknown>,
  ): Promise<IssuedSession> {
    const credentialId = response.id;
    if (typeof credentialId !== 'string') {
      throw new AuthenticationError(
        'validation_failed',
        400,
        'Missing credential ID',
      );
    }
    const authenticator = await this.#store.findAuthenticator(credentialId);
    const challenge = challengeFromResponse(response);
    const stored = await this.#store.consumeChallenge(
      sha256(challenge),
      'passkey_authentication',
      this.#now(),
    );
    if (!authenticator || !stored || stored.userId !== authenticator.userId) {
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Passkey verification failed',
      );
    }
    const verification = await verifyAuthenticationResponse({
      response: response as unknown as AuthenticationResponseJSON,
      expectedChallenge: stored.challenge,
      expectedOrigin: this.#expectedOrigin,
      expectedRPID: this.#rpId,
      requireUserVerification: true,
      credential: {
        id: authenticator.credentialId,
        publicKey: Buffer.from(authenticator.publicKey, 'base64url'),
        counter: authenticator.counter,
        transports: authenticator.transports as AuthenticatorTransportFuture[],
      },
    });
    if (!verification.verified) {
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Passkey verification failed',
      );
    }
    await this.#store.updateAuthenticatorCounter(
      authenticator.id,
      verification.authenticationInfo.newCounter,
      this.#now(),
    );
    const owner = await this.#store.getOwner();
    if (!owner)
      throw new AuthenticationError(
        'authentication_required',
        401,
        'Owner missing',
      );
    return this.#issueSession(owner.id, owner.displayName);
  }

  async passkeyCount(userId: string): Promise<number> {
    return this.#store.countAuthenticators(userId);
  }

  sessionCookie(token: string): string {
    return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  csrfCookie(token: string): string {
    return `${CSRF_COOKIE}=${encodeURIComponent(token)}; Path=/; SameSite=Strict${this.secureCookies ? '; Secure' : ''}`;
  }

  clearCookies(): readonly string[] {
    const secure = this.secureCookies ? '; Secure' : '';
    return [
      `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
      `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0${secure}`,
    ];
  }

  async #issueSession(
    userId: string,
    displayName: string,
    recoveryCodes?: readonly string[],
  ): Promise<IssuedSession> {
    const now = this.#now();
    const token = opaqueToken();
    const csrfToken = opaqueToken();
    const absoluteExpiresAt = new Date(now.getTime() + this.#absolute);
    await this.#store.createSession({
      id: createUuidV7<'session'>(),
      userId,
      tokenHash: sha256(token),
      csrfTokenHash: sha256(csrfToken),
      now,
      idleExpiresAt: new Date(
        Math.min(now.getTime() + this.#idle, absoluteExpiresAt.getTime()),
      ),
      absoluteExpiresAt,
    });
    return {
      token,
      csrfToken,
      displayName,
      expiresAt: absoluteExpiresAt,
      ...(recoveryCodes === undefined ? {} : { recoveryCodes }),
    };
  }

  async #hashPassword(password: string): Promise<string> {
    return argon2.hash(password, {
      type: argon2.argon2id,
      memoryCost: 19_456,
      timeCost: 2,
      parallelism: 1,
      hashLength: 32,
    });
  }

  #newRecoveryCodes(): readonly string[] {
    return Array.from({ length: RECOVERY_CODE_COUNT }, recoveryCode);
  }

  async #saveChallenge(
    challenge: string,
    userId: string,
    purpose: 'passkey_registration' | 'passkey_authentication',
  ): Promise<void> {
    await this.#store.saveChallenge({
      id: createUuidV7<'auth-challenge'>(),
      userId,
      purpose,
      challenge,
      challengeHash: sha256(challenge),
      expiresAt: new Date(this.#now().getTime() + 5 * 60 * 1000),
    });
  }
}

export function isActiveSession(
  principal: AuthenticatedPrincipal | undefined,
): principal is ActiveSession {
  return principal !== undefined && 'sessionId' in principal;
}

export function sessionRecordIsExpired(
  record: SessionRecord,
  now: Date,
): boolean {
  return record.idleExpiresAt <= now || record.absoluteExpiresAt <= now;
}
