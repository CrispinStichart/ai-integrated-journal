/** Server-only credential boundary. Never import this module into a browser. */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from 'node:crypto';
import {
  AiProviderOperationError,
  type AiProviderDescriptor,
} from './common.js';

export interface EncryptedCredential {
  readonly ciphertext: string;
  readonly nonce: string;
  readonly encryptionVersion: number;
}
export interface ProviderCredentialCipher {
  encrypt(
    ownerId: string,
    providerId: string,
    value: string,
  ): EncryptedCredential;
  decrypt(
    ownerId: string,
    providerId: string,
    value: EncryptedCredential,
  ): string;
  fingerprint(value: string): string;
}
export function createProviderCredentialCipher(
  base64UrlKey: string,
): ProviderCredentialCipher {
  const key = Buffer.from(base64UrlKey, 'base64url');
  if (key.byteLength !== 32)
    throw new RangeError(
      'Provider credential encryption requires a 256-bit key.',
    );
  const aad = (ownerId: string, providerId: string) =>
    Buffer.from(`provider-credential:v1:${ownerId}:${providerId}`);
  return {
    encrypt(ownerId, providerId, value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      cipher.setAAD(aad(ownerId, providerId));
      const ciphertext = Buffer.concat([
        cipher.update(value, 'utf8'),
        cipher.final(),
        cipher.getAuthTag(),
      ]);
      return {
        ciphertext: ciphertext.toString('base64url'),
        nonce: nonce.toString('base64url'),
        encryptionVersion: 1,
      };
    },
    decrypt(ownerId, providerId, value) {
      try {
        const nonce = Buffer.from(value.nonce, 'base64url');
        const bytes = Buffer.from(value.ciphertext, 'base64url');
        if (
          value.encryptionVersion !== 1 ||
          nonce.length !== 12 ||
          bytes.length <= 16
        )
          throw new Error();
        const decipher = createDecipheriv('aes-256-gcm', key, nonce);
        decipher.setAAD(aad(ownerId, providerId));
        decipher.setAuthTag(bytes.subarray(-16));
        return Buffer.concat([
          decipher.update(bytes.subarray(0, -16)),
          decipher.final(),
        ]).toString('utf8');
      } catch {
        throw new AiProviderOperationError({
          code: 'provider_authentication_failed',
          retryable: false,
        });
      }
    },
    fingerprint(value) {
      return createHmac('sha256', key)
        .update('provider-credential-idempotency:v1:')
        .update(value)
        .digest('hex');
    },
  };
}
export function canonicalProviderJson(value: unknown): string {
  if (Array.isArray(value))
    return `[${value.map(canonicalProviderJson).join(',')}]`;
  if (value !== null && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(
        ([key, item]) =>
          `${JSON.stringify(key)}:${canonicalProviderJson(item)}`,
      )
      .join(',')}}`;
  return JSON.stringify(value);
}
export function providerDisclosureVersion(
  descriptor: AiProviderDescriptor,
): string {
  return createHash('sha256')
    .update(canonicalProviderJson(descriptor.disclosure))
    .digest('hex');
}
