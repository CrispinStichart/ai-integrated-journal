import { createDatabaseClient } from '../client.js';
import { parseDatabaseCommandEnvironment } from '../environment.js';
import {
  createQueueClient,
  provisionQueueFoundation,
} from '../queue-runtime.js';
import { seedDatabase } from '../seeds.js';

const { appEnvironment, databaseUrl } = parseDatabaseCommandEnvironment(
  process.env,
);
const client = createDatabaseClient({ connectionString: databaseUrl });
const boss = createQueueClient(databaseUrl, true);

try {
  const result = await seedDatabase(client.database, appEnvironment);
  await provisionQueueFoundation(boss, client);
  console.log(
    `Database seed completed (${result.queuesRequested} queues, ${result.schedulesRequested} schedules, ${result.processorsRequested} processors, ${result.developmentFixturesRequested} development fixtures requested).`,
  );
} finally {
  await boss.stop({ graceful: true, timeout: 10_000 });
  await client.close();
}
