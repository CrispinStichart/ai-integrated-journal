# Provider key is reused for encryption and fingerprinting

## Problem

The provider credential cipher uses the same raw 256-bit deployment key for two different cryptographic purposes:

- AES-256-GCM encryption of provider credentials; and
- HMAC-SHA-256 fingerprints used to build secret-free idempotency hashes.

The HMAC input has a purpose-specific prefix, but domain separation in the input does not create independent cryptographic keys.

## Security impact

There is no evident practical attack against the current construction solely because AES-GCM and HMAC share this uniformly random key. Nevertheless, key separation limits cross-protocol assumptions, makes each key's purpose explicit, and permits independent evolution or retirement of encryption and fingerprint schemes.

Reusing the root material directly also makes future rotation and versioning harder because both stored ciphertext and derived idempotency behavior change as one unit.

## Evidence

- `apps/api/src/settings-service.ts` decodes `AI_CREDENTIAL_ENCRYPTION_KEY` once and passes the resulting `key` directly to both `createCipheriv('aes-256-gcm', key, nonce)` and `createHmac('sha256', key)`.
- The [OWASP Cryptographic Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html) recommends independent keys when multiple keys or cryptographic purposes are involved.

## Expected resolution

Treat `AI_CREDENTIAL_ENCRYPTION_KEY` as root key material and derive independent, purpose-bound subkeys with a standard KDF such as HKDF. Use distinct context labels and versions for credential encryption and idempotency fingerprinting. Define compatibility behavior for existing ciphertext and idempotency receipts before changing the derivation.
