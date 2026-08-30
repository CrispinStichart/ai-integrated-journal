# Settings and privacy controls

The authenticated **Settings** page is the owner-facing control plane for
journal timezone, retention, AI providers, encrypted offline storage, nudge
delivery, exports, encrypted backups, privacy guarantees, and active sessions.
Settings reads use `Cache-Control: no-store`; writes require the session CSRF
token, a unique idempotency key, and the current strong settings ETag.

## Providers, models, and credentials

Only adapters registered by the deployment are shown. Each adapter supplies its
display name, capabilities, content recipient, privacy-policy link, and known or
unknown retention/training statements. A provider cannot be enabled until the
owner accepts the exact current disclosure version. Changing that disclosure
invalidates the prior acceptance and makes the provider ineffective until it is
accepted again. Disabling a provider does not remove old sources or results.

Configured model IDs are capability-specific; provider SDK details do not enter
the canonical journal model. Credentials are write-only. API responses and
exports expose only whether a credential exists, never its value. To enable
encrypted credential writes, generate a deployment key and add it to `.env`:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
# AI_CREDENTIAL_ENCRYPTION_KEY=<the generated value>
```

The API encrypts each value with AES-256-GCM, a fresh nonce, and owner/provider
authenticated context before persistence. Keep the deployment key outside the
journal and backup corpus. Losing or changing it requires replacing stored
provider credentials. Credential values, ciphertext, and secret fingerprints
are excluded from audit metadata and application logs.

## Time, retention, nudges, export, and backup

- The journal timezone is an IANA timezone and affects only future default day
  assignment. Existing contributions are never silently moved.
- Journal material and original audio have independent deletion grace periods.
  Original audio defaults to indefinite retention. Provider raw responses can
  be disabled or retained for 30 days, 90 days, one year, or indefinitely.
- Nudge quiet hours and the daily digest limit use the owner timezone. Processor
  failures do not consume the allowance or appear as missing information.
- Export controls remain on the dedicated **Exports** page. Downloaded archives
  are outside later application deletion and cache controls, and credentials are
  never included.
- Backup scheduling is available only after the encrypted restic paths are fully
  configured. Enabling it updates both the durable schedule policy and the
  `pg-boss` daily 03:30 UTC schedule consumed by the backup worker. The default
  retention is 7 daily, 5 weekly, and 12 monthly snapshots. See
  [backup-and-restore.md](backup-and-restore.md) for setup and recovery drills.

## Offline cache and sessions

Private IndexedDB records use the separate local unlock described in
[ADR-0009](adr/0009-privacy-evidence-and-retention-defaults.md). The page shows
read-cache usage, expiry age, and pending recovery-item count. Clearing the read
cache never evicts pending notes or recording chunks. Locking discards the
in-memory key.

Active-session rows contain only timestamps and opaque session IDs. Revocation
is owner-scoped and audited. Revoking the current session clears authentication
cookies, asks the browser to clear caches, locks local private data, and returns
the application to its unauthenticated state. Encrypted unsynchronized recovery
records remain owner-bound as required by the offline privacy policy.
