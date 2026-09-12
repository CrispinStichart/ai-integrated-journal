# Provider credential key rotation is not supported

## Problem

Provider credentials are encrypted directly with one deployment-owned key. Although each database row has an `encryption_version`, it has no key identifier, and there is no credential decryption, re-encryption, or multi-key rotation path.

Changing or losing `AI_CREDENTIAL_ENCRYPTION_KEY` makes every stored provider credential unusable. The documented recovery procedure is to ask the owner to enter all credentials again.

This limitation is currently explicit and no production provider is wired, so it is not blocking today's deterministic-only runtime. It becomes an operational and incident-response problem once real provider integrations depend on stored credentials.

## Security impact

The application cannot rotate the key routinely or promptly after suspected exposure without interrupting every configured provider. A key change is an all-at-once destructive event for credential availability, and there is no way to distinguish records written with old and new keys during a staged migration.

Because credentials are intentionally excluded from API responses and are supposed to be excluded from backups, the application also cannot reconstruct them from another application-managed copy.

## Evidence

- `apps/api/src/settings-service.ts` implements credential encryption but no decryption or re-encryption operation.
- `packages/database/src/schema.ts` stores an encryption version but no key ID.
- `README.md` and `docs/configuration.md` state that changing or losing the key requires replacing stored credentials.
- As one comparison, [n8n's self-hosted key-rotation design](https://github.com/n8n-io/n8n-docs/blob/main/docs/deploy/host-n8n/configure-n8n/security/rotate-encryption-keys.md) uses a stable instance key to wrap rotatable data-encryption keys and retains old keys while records migrate.

## Expected resolution

Before enabling a production provider, define a credential-key lifecycle that supports key IDs, active and retired keys, staged re-encryption, rollback and failure handling, and an operator recovery procedure. Envelope encryption with a stable root key and rotatable credential data-encryption keys is one suitable model; a small installation could instead support a carefully transactional all-record re-encryption command.
