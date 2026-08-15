import { createDatabaseClient } from '../client.js';
import { parseDatabaseCommandEnvironment } from '../environment.js';
import { seedDatabase } from '../seeds.js';

const { appEnvironment, databaseUrl } = parseDatabaseCommandEnvironment(
  process.env,
);
const client = createDatabaseClient({ connectionString: databaseUrl });

try {
  const result = await seedDatabase(client.database, appEnvironment);
  console.log(
    `Database seed completed (${result.queuesRequested} queues, ${result.schedulesRequested} schedules, ${result.processorsRequested} processors, ${result.developmentFixturesRequested} development fixtures requested).`,
  );
} finally {
  await client.close();
}
