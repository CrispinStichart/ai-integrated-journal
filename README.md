# AI-Integrated Journal

This repository is a pnpm workspace containing the web, API, worker, and shared packages for the journaling application.

## Prerequisites

- Node.js 24.18.0 (see `.node-version` and `.nvmrc`)
- Corepack, included with the pinned Node.js release
- Docker with the Compose plugin (used by local PostgreSQL and persistence tests)

## Setup

```sh
corepack pnpm install --frozen-lockfile
```

Copy the local configuration, replace its database-password and blob-path placeholders, and restrict it to your OS account:

```sh
cp .env.example .env
chmod 600 .env
```

Then start PostgreSQL, prepare storage, migrate/seed, and run the API, worker, and web app with one command:

```sh
corepack pnpm local:start
```

Run `corepack pnpm local:start -- --check` for a content-safe configuration and Docker preflight. See the [operations runbook](docs/operations-and-release.md), [configuration reference](docs/configuration.md), and [infrastructure guide](infrastructure/README.md) for data ownership, shutdown, upgrades, providers, deletion, backup/restore, troubleshooting, and recovery drills.

Run every local quality gate, production build, and Firefox end-to-end test:

```sh
corepack pnpm validate
```

The pre-commit hook runs the same validation command unless all staged changes are Markdown files, all are under `.devcontainer/`, or all are under `.git/`. Validation includes unit tests, operations/documentation checks, and containerized PostgreSQL persistence tests, so Docker must be running. Useful focused commands are `format:check`, `lint`, `boundaries`, `openapi:check`, `typecheck`, `test`, `test:operations`, `test:infrastructure`, `build`, and `test:e2e`. Run `test:coverage` separately to generate optional text, HTML, and LCOV reports; coverage percentages are informational and do not gate validation.

## Adding AI providers

AI integrations live behind provider-neutral ports in [`@journal/ai`](packages/ai/src/index.ts). A provider is an `AiProviderFactory` with a stable descriptor and an adapter that implements one or more capabilities. The descriptor drives the Settings screen, so it must list the same capabilities as the adapter and accurately state who receives content, whether that recipient is external, its retention policy, training use, and an HTTPS privacy-policy URL when applicable.

There is deliberately no production provider in this repository yet. Both [`apps/api/src/main.ts`](apps/api/src/main.ts) and [`apps/worker/src/main.ts`](apps/worker/src/main.ts) currently create an empty `AiProviderFactoryRegistry` and resolve a disabled provider named `unconfigured`. Adding an adapter alone will compile, but will not make AI operations available until the composition work below is complete.

### Speech-to-text provider

1. Implement `SpeechToTextProvider` from [`speech-to-text.ts`](packages/ai/src/speech-to-text.ts). `transcribe` receives streamed audio, its media type and optional size/name, content-bearing context, and provider-neutral configuration.
2. Normalize the provider response into `SpeechToTextResult`: full text, segments, optional word timing/confidence, language, exact effective context, operation provenance, and the exact raw response bytes. Represent missing timing, confidence, or language as `unknown`; never invent it.
3. Expose the port as `speech_to_text` from an `AiProviderFactory`. Keep SDK types and provider-specific response shapes inside the adapter.
4. Translate expected SDK/HTTP failures to `AiProviderOperationError`. The error contains only a stable code, retryability, and an optional retry delay; it must not contain audio, transcript text, credentials, or response bodies.
5. Register the same factory in the API and worker registries. The API needs the descriptor so the provider appears in Settings; the worker needs the adapter so [`transcription-pipeline.ts`](apps/worker/src/transcription-pipeline.ts) can execute it.

The transcription pipeline streams the immutable audio blob to the adapter, persists the normalized transcript and provider/model/configuration provenance, and stores the exact raw response for the pipeline's current fixed 30-day retention period. An adapter must consume the audio stream once, propagate stream failures, and exclude secret headers from `rawResponse` and operation snapshots.

### Structured generation and embeddings

The remaining model-backed features use two ports:

- `StructuredGenerationProvider` in [`structured-generation.ts`](packages/ai/src/structured-generation.ts) powers transcript cleanup, processors, and grounded answers. Its adapter must request structured output, pass the decoded value through `outputSchema.parse`, and return the exact effective messages, prompt/schema identities, token usage, provenance, and raw response. Do not return unvalidated model output.
- `EmbeddingProvider` in [`embeddings.ts`](packages/ai/src/embeddings.ts) powers semantic search. It must preserve every fragment ID, return finite vectors of one declared dimension, and report usage, provenance, and the raw response. Never mix indexes produced by different provider/model/version/dimension cohorts.

One factory may expose speech, structured generation, embeddings, or any combination of them. Add only the implemented capability names to its descriptor. Register the factory in both composition roots, then route each worker resolver—and the API search resolver—to the enabled owner-scoped provider and model for that capability.

The existing composition roots do not yet read provider configuration or decrypt credentials for execution. A production integration must add that server-only boundary: load the current owner's enabled configuration, verify the accepted disclosure version, decrypt only that provider's credential, pass the secret to the adapter without placing it in public settings or provenance, and discard it after use. Some resolver signatures currently take no canonical job input, so they must also be extended where necessary to identify the owner.

Use the deterministic implementations in [`packages/test-support/src/fake-ai.ts`](packages/test-support/src/fake-ai.ts) as contract examples. Add adapter tests for normalization, unknown metadata, schema rejection, cancellation, error classification, sanitized snapshots, raw byte preservation, and registry resolution. Then run `corepack pnpm validate`.

## Encryption model

Encryption is split by threat boundary; there is no single application key.

### Browser offline data

Enabling offline storage creates a random 256-bit data-encryption key (DEK) in the browser. The local unlock secret is processed with PBKDF2-HMAC-SHA-256, a random 128-bit salt, and 600,000 iterations to derive an AES-256-GCM wrapping key. Only the wrapped DEK, salt, and iteration count are stored. The unlock secret and unwrapped DEK remain in memory and are never sent to the server.

Each journal cache record, pending mutation, and recording checkpoint is encrypted with the DEK using AES-256-GCM and a fresh 96-bit nonce. Authenticated additional data binds the ciphertext to the owner ID, record kind, stable ID, and cache schema version, preventing a record from being moved into another identity or context. Lock, logout, session expiry, and revocation discard the in-memory key. Logout clears cached reads but retains encrypted unsynchronized recovery data; recovering that local-only data requires the same owner session and local unlock secret. See [`offline.ts`](apps/web/src/journal/offline.ts) and [ADR-0009](docs/adr/0009-privacy-evidence-and-retention-defaults.md).

### Provider credentials

`AI_CREDENTIAL_ENCRYPTION_KEY` is a deployment-owned 256-bit key, encoded as 43 base64url characters. The API encrypts each submitted provider credential with AES-256-GCM and a fresh 96-bit nonce. The authenticated additional data is `provider-credential:v1:<owner-id>:<provider-id>`, so ciphertext cannot be silently reassigned. The authentication tag is appended to the ciphertext; the nonce and encryption version are stored beside it in PostgreSQL. An HMAC-SHA-256 fingerprint supports secret-free idempotency checks.

Credentials are write-only through the API/UI and are excluded from responses, logs, audits, exports, and backups. The deployment key must be stored separately from journal and backup data. Losing or changing it makes stored credentials unusable, so they must be entered again. The current code implements encrypted credential writes but, because no production provider is wired, no credential read/decrypt path yet; add that narrow server-only path as part of a production provider integration. See [`settings-service.ts`](apps/api/src/settings-service.ts) and the [configuration reference](docs/configuration.md).

### Backups and server-side data

Backups use an encrypted restic repository with a separate password file that is never included in the snapshot. The coordinated snapshot contains the PostgreSQL dump and referenced blobs but excludes provider credentials, authentication/session material, recovery codes, and application encryption keys. See [backup and restore](docs/backup-and-restore.md).

The live PostgreSQL journal and server blob directory are not encrypted by the application. They rely on localhost-only exposure, owner-only filesystem permissions, and operator-managed full-disk or volume encryption. Application encryption therefore does not replace host security, protected `.env` files, or separate recovery copies of keys.

## Processors

A processor turns immutable journal inputs into schema-validated, evidenced artifacts. A processor installation has a stable UUIDv7/key and mutable display configuration; each behavior change is a new immutable version. The current version controls future scheduling only. Existing runs and artifacts retain the exact processor version, source revisions, prompt hashes, provider/model configuration, and reconciliation history that produced them.

### How processing works

1. A source change schedules an identifier-only queue job. The worker reloads the authoritative run, processor version, and immutable source revisions from PostgreSQL rather than trusting queue content.
2. Input scope/selectors and exact upstream version dependencies select typed text, corrected or cleaned transcripts, observations, or processor results. Dependencies are fixed version IDs with JSON Pointer output selectors and must form an acyclic graph.
3. [`assembleProcessorInput`](packages/processors/src/runtime.ts) builds a deterministic, size-bounded bundle and fingerprints it. Oversized input fails unless the version explicitly allows partial input; partial input must produce an explicitly partial result.
4. A `structured_generation` processor receives a fixed system policy plus the journal bundle as untrusted data. A `deterministic` processor calls a local implementation selected by immutable version ID. Code execution, tools, SQL, and HTML are prohibited output channels.
5. The result envelope contains `completeness`, a JSON `payload`, and exact evidence spans. The runtime validates result size, the version's bounded JSON Schema, UTF-16 evidence coordinates and quotes, and any built-in semantic rules before persistence.
6. Reconciliation applies the version's `replace_scope`, `logical_key`, or `append_only` policy. Generated proposals cannot overwrite manual authority. Retries are idempotent, failures retain explicit state, and downstream work follows recorded version dependencies.

See [processor definition management](docs/processor-definitions.md) and [ADR-0005](docs/adr/0005-processor-dependencies-and-versioning.md) for the full schema, limits, API, versioning, and invalidation rules.

### Adding a configurable processor

For a processor that needs only the generic runtime, open **Processors** in the web app:

1. Create a stable kebab-case key, name, and purpose.
2. Edit the JSON definition. Choose its kind, input scope/selectors, immutable dependencies, output schema/version, reconciliation strategy, requirement and nudge defaults, capability requirements, partial-input policy, and resource limits. Keep output-safety mode set to `data_only` and all four executable-channel allow flags set to `false`.
3. Run the dry-run validator. This checks the definition, schema bounds, dependency selectors, and graph without publishing or creating an authoritative artifact; it is not a model-quality evaluation.
4. Publish the immutable version, enable the processor, and select a current version. Mark it required only if missing-information nudges are desired.

Changing instructions, schemas, inputs, dependencies, reconciliation, safety, or capabilities requires publishing another version. Selecting it does not rewrite history; use the explicit reprocessing preview/confirmation flow when old journal days should be recomputed.

### Adding a built-in or deterministic processor in code

Use an existing file under [`packages/processors/src/built-ins`](packages/processors/src/built-ins) as the template. Define stable processor/version UUIDv7s and a key, export a `ProcessorDefinitionDraft`, add domain-specific validation when JSON Schema is insufficient, and include synthetic fixtures and tests for absence, ambiguity, correction, evidence, and reconciliation behavior. Export it from [`packages/processors/src/index.ts`](packages/processors/src/index.ts), route extra semantic validation from [`built-ins/validate.ts`](packages/processors/src/built-ins/validate.ts), and add its installation/version/fixture seeds in [`packages/database/src/seeds.ts`](packages/database/src/seeds.ts). Seeds must insert without overwriting operator-selected versions.

For a truly local deterministic implementation, set `capabilityRequirements` to only `deterministic`, implement the `DeterministicProcessor` contract in [`apps/worker/src/processor-runtime.ts`](apps/worker/src/processor-runtime.ts), and pass a `resolveDeterministic` mapping keyed by immutable processor-version ID when registering the worker consumer. The production composition root does not currently provide that resolver, so this registration step is required. In both paths, add package, worker, database, API, and UI tests appropriate to the new behavior before running the full validation command.
