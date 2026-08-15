# Queue transactionality spike

This executable spike proves that a `pg-boss` job insert and a Drizzle mutation
share one PostgreSQL transaction when `pg-boss`'s official `fromDrizzle`
adapter is passed to `boss.send`.

## Run

Prerequisites are Node.js 22.22 or newer and a running Docker daemon. The test
starts an isolated PostgreSQL 17.6 container and removes it afterward.

```sh
cd spikes/queue-transactionality
npm ci
npm test
```

The first test proves the commit path. The second deliberately throws after
both inserts and verifies through a separate connection that neither the
application row nor the queue job exists. No database URL, persistent volume,
or pre-existing PostgreSQL instance is used.
