import type { PgTransactionConfig } from 'drizzle-orm/pg-core';

import type { JournalDatabase, JournalTransaction } from './client.js';

export type TransactionWork<Result> = (
  transaction: JournalTransaction,
) => Promise<Result>;

/**
 * Runs persistence work through one explicit transaction. Repositories accept
 * the callback transaction so queue producers can use the same connection with
 * pg-boss's `fromDrizzle` adapter (ADR-0007).
 */
export function inTransaction<Result>(
  database: JournalDatabase,
  work: TransactionWork<Result>,
  config?: PgTransactionConfig,
): Promise<Result> {
  return database.transaction(work, config);
}
