# ADR-0007: Insert queue jobs through the active Drizzle transaction

- Status: Accepted
- Date: 2026-08-15
- Deciders: Project maintainers
- Requirements: STATE-001, STATE-006, STATE-007

## Context

Application state and the asynchronous work required by that state must not
diverge. Enqueuing after commit can lose work if the process crashes between
the commit and enqueue. Enqueuing on an independent connection before commit
can expose work whose canonical application state later rolls back. An
application-managed transactional outbox would solve this, but adds a table,
dispatcher, monitoring surface, and delivery delay.

The selected versions are `pg-boss` 12.26.3, Drizzle ORM 0.45.2, and `pg`
8.23.0. `pg-boss` exposes an official `fromDrizzle(transaction, sql)` adapter.
Passing that adapter as `boss.send(..., { db })` executes the queue insertion
through the active Drizzle transaction rather than the boss instance's pool.

The executable integration proof is in `spikes/queue-transactionality`. Against
PostgreSQL 17.6 it demonstrates that commit makes both an application row and
its job visible, while a forced rollback leaves neither visible.

## Decision

Use direct transactional `pg-boss` insertion. A mutation that creates durable
work must call `boss.send` before returning from the same Drizzle transaction,
with `db: fromDrizzle(transaction, sql)`. Calling `boss.send` without this
per-call adapter is forbidden in a mutation transaction.

Queue schema installation and queue creation remain explicit deployment/seed
steps outside request transactions. Transactional sends assume the queue and
the compatible `pg-boss` schema already exist. Application and queue schema
versions are checked before API or worker startup.

Job payloads contain identifiers and a payload schema version, never journal
content. The durable work/run identity supplies a deterministic UUID as the
`pg-boss` job ID. The application mutation's idempotency record and work/run
row are created in the same transaction; a repeated request returns the prior
result and does not create a second logical run.

## Crash and retry semantics

- Crash or error before commit: PostgreSQL rolls back both the application
  mutation and job. Retrying the idempotent request may safely attempt both
  again.
- Successful commit: both records become visible atomically. A worker can
  observe the job only after its canonical state is committed.
- Connection loss during commit: the client treats the outcome as unknown and
  retries with the same idempotency key and durable work/run ID. Reading the
  idempotency record resolves whether the first transaction committed. The
  deterministic job UUID is an additional uniqueness guard, not the primary
  idempotency mechanism.
- API crash after commit but before responding: the retry returns the stored
  mutation result; it does not create another run or job.
- Worker crash before claiming a job: the committed job remains queued.
- Worker crash after claim: `pg-boss` expiration/heartbeat and retry settings
  return eligible work to processing. Handlers are idempotent and re-read
  canonical state before side effects.
- Handler failure: transient failures use bounded exponential retries;
  permanent failures enter the durable failed/dead-letter lifecycle. A retry
  never overwrites a successful artifact and records each attempt separately.
- Duplicate delivery or manual redrive: the durable run/fingerprint and output
  uniqueness constraints make processing safe. Workers no-op when canonical
  state says the run is canceled, superseded, stale, or already complete.

This is atomic enqueue with retryable, at-least-once execution. It is not a
claim that arbitrary worker side effects are exactly once.

## Consequences

- No application transactional outbox is needed for queue jobs with the pinned
  library versions.
- Producers are coupled intentionally to the concrete `pg-boss` API and its
  Drizzle adapter, matching the technical specification.
- Transaction helpers must make the active transaction available to queue
  producers, and integration tests must retain a forced-rollback case.
- Upgrading Drizzle, `pg`, or `pg-boss` requires rerunning this proof. A version
  that cannot pass it blocks the upgrade unless a superseding ADR adopts a
  transactional outbox.

## Rejected alternatives

- Enqueue after commit has an unrecoverable crash window.
- Enqueue on the boss pool inside a Drizzle callback does not share the active
  transaction.
- A transactional outbox is unnecessary complexity while the supported direct
  adapter passes the atomicity proof; it remains the fallback if that changes.
