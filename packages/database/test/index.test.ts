import { describe, expect, it } from 'vitest';

import {
  createDatabaseClient,
  databasePackageName,
  migrationsFolder,
  parseDatabaseCommandEnvironment,
} from '../src/index.js';

describe('@journal/database operational shell', () => {
  it('exposes its package identity', () => {
    expect(databasePackageName).toBe('@journal/database');
  });

  it('resolves the checked-in forward migration folder', () => {
    expect(migrationsFolder).toMatch(/packages\/database\/drizzle$/);
  });

  it('parses the isolated database command environment', () => {
    expect(
      parseDatabaseCommandEnvironment({
        APP_ENV: 'test',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      }),
    ).toEqual({
      appEnvironment: 'test',
      databaseUrl: 'postgresql://journal@localhost/journal',
    });
  });

  it('creates and closes a lazy PostgreSQL client without opening a connection', async () => {
    const client = createDatabaseClient({
      connectionString: 'postgresql://journal@127.0.0.1:1/journal',
    });

    expect(client.database).toBeDefined();
    expect(client.pool.totalCount).toBe(0);
    await client.close();
  });

  it.each([
    [{}, 'DATABASE_URL'],
    [{ DATABASE_URL: 'https://localhost/journal' }, 'postgres'],
    [
      {
        APP_ENV: 'preview',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      },
      'APP_ENV',
    ],
  ])(
    'rejects invalid command configuration without echoing secrets',
    (input, message) => {
      expect(() => parseDatabaseCommandEnvironment(input)).toThrowError(
        message,
      );
    },
  );
});
