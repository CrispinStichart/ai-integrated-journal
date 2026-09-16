# Configuration reference

The supported release is a private, single-owner localhost installation. The API, worker, database, and development web server must stay on loopback. A LAN or hosted deployment needs a new deployment ADR, HTTPS, network policy, managed secret storage, hosted blob/backup decisions, and a new security review.

## Local environment file

Copy `.env.example` to `.env`, replace every placeholder, and restrict it to the OS account that runs the journal:

```sh
cp .env.example .env
chmod 600 .env
corepack pnpm local:start -- --check
```

`.env` is ignored by Git. `local:start` parses it as data and supports `${KEY}` references to earlier assignments; it never evaluates shell commands. An already exported environment key overrides the file, which is useful for a disposable drill target. The configuration check reports field names and policy failures only, not values, and proves the blob path has a writable existing ancestor before Compose changes anything. The root migration, seed, data-bootstrap, and backup commands use the same safe loader, so they work from a configured checkout without sourcing `.env` into a shell. Compose is likewise passed the repository-root file explicitly. Application processes parse their environment once and fail before listening or claiming jobs when it is invalid.

## Application and Compose keys

| Key | Required/default | Consumer | Meaning and safety rule |
| --- | --- | --- | --- |
| `APP_ENV` | `development` | API, worker, seeds, backup metadata | `development`, `test`, or `production`. Development seeds synthetic fixtures; do not use it for real hosted data. |
| `JOURNAL_DATABASE_PASSWORD` | Required by local startup and Compose | Compose | Local PostgreSQL password. Replace the example placeholder. Use URL-safe unreserved characters (`A-Z`, `a-z`, digits, `.`, `_`, `~`, `-`) so the same value can be expanded safely into `DATABASE_URL`. Compose has no fallback password. |
| `DATABASE_URL` | Required | API, worker, migrations, seeds, backup | PostgreSQL URL. In the dev container use `host.docker.internal`; directly on the Docker host use `127.0.0.1`. Its password must match `JOURNAL_DATABASE_PASSWORD` for the supported local workflow. Never put it in command arguments, logs, exports, or documentation evidence. |
| `BLOB_DATA_DIR` | Required, absolute | API, worker, backup | Live local object root, outside the repository. `data:bootstrap` creates it and `final`, `staging`, and `temporary` with owner-only directory modes. It must not overlap backup paths. |
| `HTTP_HOST` | `127.0.0.1` | API | Only `localhost`, `127.0.0.1`, or raw `::1` is accepted. Wildcard, LAN, bracketed IPv6, and arbitrary hostnames fail closed. |
| `HTTP_PORT` | `3000` | API | Integer from 1 through 65535. Vite's development proxy expects port 3000. |
| `LOG_LEVEL` | `info` | API, worker | `trace`, `debug`, `info`, `warn`, `error`, `fatal`, or `silent`. Higher verbosity does not authorize content or secrets in logs. |
| `AUTH_ORIGIN` | `http://localhost:5173` | API authentication | Exact browser origin. Plain HTTP is accepted only for localhost browser secure-context behavior; every non-local origin requires HTTPS. |
| `WEBAUTHN_RP_ID` | `localhost` | API authentication | Must exactly match the hostname in `AUTH_ORIGIN`. |
| `AI_CREDENTIAL_ENCRYPTION_KEY` | Unset | API and worker | Optional 43-character base64url encoding of 256 random bits. It enables encrypted provider credential writes in the API and decryption in the worker. OpenAI is registered but requires owner enablement, disclosure acceptance, an API credential, and capability model IDs in Settings. Keep it outside journal data, exports, and backups. |
| `BACKUP_REPOSITORY_DIR` | All three backup keys unset | API, worker, backup tool | Absolute encrypted restic repository path, preferably on another device/filesystem. |
| `BACKUP_PASSWORD_FILE` | All three backup keys unset | API, worker, backup tool | Absolute owner-only restic password-file path. `backup:init` creates it with mode `0600`; store a separate recovery copy. |
| `BACKUP_STAGING_DIR` | All three backup keys unset | API, worker, backup tool | Absolute owner-only staging path. It must not overlap the repository or live blobs. |

The three backup keys are atomic configuration: set all or none. The parser rejects overlapping live blob, repository, password, and staging paths.

Generate the provider encryption key without printing it into shell history as an assignment:

```sh
node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"
```

Paste the output into the protected `.env`, then restart the API and worker with the same key. Changing or losing this deployment key makes existing provider credential ciphertext unreadable; journal sources and prior results remain intact.

## Restore-only keys

These keys are consumed only by `backup:restore`; they do not belong in normal application startup:

| Key | Required/default | Meaning |
| --- | --- | --- |
| `RESTORE_DATABASE_URL` | Required for restore | URL of a disposable empty target database. Do not reuse `DATABASE_URL`. |
| `RESTORE_BLOB_DATA_DIR` | Required for restore | Nonexistent or empty absolute target directory, separate from live and backup paths. |
| `BACKUP_SNAPSHOT_ID` | Latest compatible tagged snapshot | Explicit restic snapshot to restore. Use an immutable recorded ID for a drill. |

Restore also needs the three backup keys. Database credentials are passed in the environment rather than command arguments.

## Owner-managed settings

The authenticated **Settings** page stores versioned owner policy in PostgreSQL, not `.env`: journal timezone, independent material/audio grace periods, original audio and provider-raw retention, nudge quiet hours and daily limits, backup schedule enablement, provider disclosure acceptance, capability model IDs, provider enablement, and write-only credentials. See [settings-and-privacy.md](settings-and-privacy.md).

Backups exclude all credentials, session material, recovery codes, and the provider encryption key. Exports exclude credentials and include provider raw bodies only after a separate explicit selection. Environment errors, logs, and health output must never reproduce secret values.

## OpenAI setup

Open **Settings → OpenAI**, enter an API key, set `structured_generation` to a Responses-compatible text model and `speech_to_text` to `gpt-transcribe`, `gpt-4o-transcribe`, `gpt-4o-mini-transcribe`, or `whisper-1`, accept the disclosure, and enable the provider. There are no automatic model defaults. Text models must support JSON-schema output and the job parameters; built-in jobs use `temperature: 0`.

Whisper requests word and segment timestamps. GPT transcription leaves unavailable timing, confidence, and language metadata unknown. Supported audio containers are MP3, MP4/M4A, MPEG/MPGA, WAV, and WebM, with a 25,000,000-byte limit per recording. The adapter does not split or transcode audio. Each request has a two-minute timeout and supports job cancellation.

The worker rereads settings for every operation. Disabling OpenAI, removing its credential, or changing its disclosure prevents subsequent requests; it does not revoke an already-sent request. API keys are supplied only from encrypted owner settings, never from job configuration. Structured text requests use `store: false`; this does not eliminate all provider retention. See [OpenAI's data controls](https://developers.openai.com/api/docs/guides/your-data). Embeddings remain unavailable, so search retains its existing lexical fallback.
