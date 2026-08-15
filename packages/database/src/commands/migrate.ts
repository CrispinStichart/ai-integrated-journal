import { createDatabaseClient } from '../client.js';
import { parseDatabaseCommandEnvironment } from '../environment.js';
import { migrateDatabase } from '../migrations.js';

const { databaseUrl } = parseDatabaseCommandEnvironment(process.env);
const client = createDatabaseClient({ connectionString: databaseUrl });

try {
  await migrateDatabase(client.database);
  console.log('Database migrations completed.');
} finally {
  await client.close();
}
