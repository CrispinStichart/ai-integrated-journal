# Database package

`@journal/database` owns the PostgreSQL persistence boundary: Drizzle schema,
forward-only migrations, transaction helpers, and repository implementations.

## Conventions

- Add every schema change as a new migration with `pnpm --filter
  @journal/database generate`. Never edit or delete a migration that has landed
  on `main`, and never add down migrations.
- One active task owns schema and migration changes at a time. Rebase before
  generating so migration ordering remains linear.
- A repository accepts a `RepositoryContext` in its constructor. Pass the
  active `JournalTransaction` when composing a mutation; never open a nested or
  independent connection from a repository.
- Repository methods return domain-facing records, not inferred Drizzle row
  types. Schema definitions remain internal to this package.
- Queue insertion for a mutation uses the same transaction with pg-boss's
  `fromDrizzle` adapter, as required by ADR-0007.
- Seeds use conflict-safe application inserts and reconcile pg-boss queues and
  schedules from the shared definitions. Rerunning a seed does not overwrite
  application-level operator configuration. Development fixtures are inserted
  only for `APP_ENV=development`.

Run migrations and seeds with the root `db:migrate` and `db:seed` commands.
Both require `DATABASE_URL`; seeds use `APP_ENV`, default it to `development`,
and are the explicit deployment step that installs/upgrades the pg-boss schema.
API and worker processes verify schema compatibility but never migrate it.

## Processor provenance and invalidation

Processor runs bind ordered immutable source revisions or processor results in
`processor_run_input`. Artifact bindings also persist the exact JSON Pointer,
selected-content hash, included range, and temporal snapshot. Provider, model,
requested/effective configuration, prompt assembly/template hashes, immutable
processor version, attempt lineage, and the final effective-message hash remain
on `processor_run`.

Revision mutation paths call `invalidateProcessorDependents` in the same
transaction that advances the source pointer. Its recursive traversal follows
recorded result-input edges—not today's processor-definition graph—marks only
reachable results and evidence stale, cancels unfinished obsolete attempts, and
queues root replacements with identifier-only jobs. Successful replacement
results transactionally schedule enabled current downstream versions whose
exact dependency is now available. Historical runs, results, and bindings are
never rewritten or deleted.
