import { fileURLToPath } from 'node:url';

import { migrate } from 'drizzle-orm/node-postgres/migrator';

import type { JournalDatabase } from './client.js';

export const migrationsFolder = fileURLToPath(
  new URL('../drizzle', import.meta.url),
);

export async function migrateDatabase(
  database: JournalDatabase,
  folder = migrationsFolder,
): Promise<void> {
  await migrate(database, {
    migrationsFolder: folder,
    migrationsSchema: 'journal_migrations',
    migrationsTable: '__drizzle_migrations',
  });
}
