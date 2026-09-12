# Offline unlock secret minimum is too weak

## Problem

Offline storage accepts any local unlock secret with a JavaScript string length of eight or more characters. The secret protects a wrapped data-encryption key that is stored alongside its salt, work factor, nonce, and ciphertext in IndexedDB.

An attacker with a copy of the browser profile can therefore test guesses offline without server-side rate limiting. PBKDF2 makes each guess more expensive, but an eight-character common or predictable secret can still be weak.

## Security impact

If the unlock secret is guessed, the attacker obtains the data-encryption key and can decrypt all retained cached journal payloads, unsynchronized text, and recording chunks for that offline installation. This is especially consequential for recovery data because it is deliberately retained without automatic expiry.

The configured 600,000 PBKDF2-HMAC-SHA-256 iterations match the published OWASP PBKDF2 recommendation, so the concern is the allowed secret quality rather than an obviously inadequate work factor. OWASP nevertheless prefers a memory-hard KDF such as Argon2id where it is available.

## Evidence

- `apps/web/src/journal/offline.ts` rejects the secret only when `secret.length < 8`.
- The wrapped key and every parameter needed to validate a guess are persisted in `apps/web/src/storage/indexed-db.ts`.
- The [OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html) lists 600,000 iterations for PBKDF2-HMAC-SHA-256 while emphasizing that password strength and resistance to offline guessing still matter.
- [NIST SP 800-63B](https://pages.nist.gov/800-63-4/sp800-63b.html) explains that offline attacks are not rate-limited and that longer passwords or passphrases are the primary source of guessing resistance.

## Expected resolution

Treat eight characters as insufficient for a user-chosen encryption passphrase. Encourage and enforce a substantially longer passphrase, permit password-manager generated secrets, reject commonly compromised values, and make the unrecoverable-data consequence clear during setup. Benchmark and version the KDF parameters on supported devices so they can be strengthened over time without making unlock unusable.
