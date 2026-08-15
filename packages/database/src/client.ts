import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { Pool, type PoolConfig } from 'pg';

import { databaseSchema } from './schema.js';

export type JournalDatabase = NodePgDatabase<typeof databaseSchema>;
export type JournalTransaction = Parameters<
  Parameters<JournalDatabase['transaction']>[0]
>[0];
export type RepositoryContext = JournalDatabase | JournalTransaction;

export interface DatabaseClient {
  readonly database: JournalDatabase;
  readonly pool: Pool;
  close(): Promise<void>;
}

export interface CreateDatabaseClientOptions {
  readonly connectionString: string;
  readonly pool?: Omit<PoolConfig, 'connectionString'>;
}

export function createDatabaseClient(
  options: CreateDatabaseClientOptions,
): DatabaseClient {
  const pool = new Pool({
    ...options.pool,
    connectionString: options.connectionString,
  });
  const database = drizzle(pool, { schema: databaseSchema });

  return Object.freeze({
    database,
    pool,
    close: async () => pool.end(),
  });
}
