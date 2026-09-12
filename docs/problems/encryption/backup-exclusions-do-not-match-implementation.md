# Backup exclusions do not match the implementation

## Problem

The encryption documentation says provider credentials, authentication/session material, and recovery material are excluded from backups. The backup implementation currently invokes `pg_dump` for the complete `journal` schema without excluding any table data.

PostgreSQL's `--schema=journal` option selects the schema and all objects it contains. As a result, `database.dump` appears to contain rows from tables such as `provider_credential`, `password_credential`, `authenticator`, `recovery_code`, `session`, and `auth_challenge`.

This conflicts with the promises in `README.md` and `docs/backup-and-restore.md`.

## Security impact

The dump is ultimately stored in an encrypted restic repository, so this is not the same as writing an unencrypted backup. Provider credential values also remain protected by the separate application encryption key, and authentication secrets that are normally stored as hashes remain hashed.

However, the documented compartmentalization does not currently exist. Anyone who can open the restic repository receives more security-sensitive material than the documentation says it contains. Restoring an old dump may also restore authentication state that the exclusion policy appears intended to keep out of recovery media.

## Evidence

- `README.md` says the coordinated snapshot excludes provider credentials, authentication/session material, recovery codes, and application encryption keys.
- `docs/backup-and-restore.md` says provider credentials, session secrets, and recovery material are never written to the archive.
- `packages/database/scripts/backup-core.mjs` passes `--schema=journal` to `pg_dump` but no `--exclude-table-data` options.
- `packages/database/src/schema.ts` declares all of the affected tables in the `journal` schema.
- PostgreSQL documents that [`--schema` selects the schema and all its contained objects](https://www.postgresql.org/docs/17/app-pgdump.html).

## Expected resolution

Make the implementation and documentation agree before relying on the stated backup boundary. If the exclusion policy is retained, explicitly exclude the relevant table data, define how authentication is re-established after a restore, and add a test that inspects the contents of a real custom-format dump rather than only asserting the `pg_dump` command was invoked.
