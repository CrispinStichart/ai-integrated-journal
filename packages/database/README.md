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
- Seeds use conflict-safe inserts. Rerunning a seed must not overwrite operator
  configuration. Development fixtures are inserted only for `APP_ENV=development`.

Run migrations and seeds with the root `db:migrate` and `db:seed` commands.
Both require `DATABASE_URL`; seeds use `APP_ENV` and default it to
`development`.
