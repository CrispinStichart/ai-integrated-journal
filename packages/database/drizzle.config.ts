import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  migrations: {
    prefix: 'timestamp',
    schema: 'journal_migrations',
    table: '__drizzle_migrations',
  },
  out: './drizzle',
  schema: './src/schema.ts',
  strict: true,
  verbose: true,
});
