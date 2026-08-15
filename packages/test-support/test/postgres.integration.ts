import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createPostgresTestContainer } from '../src/index.js';

type StartedContainer = Awaited<
  ReturnType<ReturnType<typeof createPostgresTestContainer>['start']>
>;

let container: StartedContainer;

beforeAll(async () => {
  container = await createPostgresTestContainer().start();
}, 60_000);

afterAll(async () => {
  await container.stop();
});

describe('PostgreSQL Testcontainers support', () => {
  it('starts an isolated database with pgvector enabled', async () => {
    const result = await container.exec([
      'psql',
      '--username',
      container.getUsername(),
      '--dbname',
      container.getDatabase(),
      '--tuples-only',
      '--no-align',
      '--command',
      "SELECT extversion FROM pg_extension WHERE extname = 'vector';",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.output.trim()).toBe('0.8.1');
  });
});
