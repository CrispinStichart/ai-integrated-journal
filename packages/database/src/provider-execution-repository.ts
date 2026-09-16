/** Server-only, narrowly scoped reads for provider execution. */
import { and, eq } from 'drizzle-orm';
import type { JournalDatabase } from './client.js';
import {
  contributions,
  journalDays,
  recordings,
  providerConfigurations,
  providerCredentials,
} from './schema.js';

export class ProviderExecutionRepository {
  public constructor(private readonly database: JournalDatabase) {}

  public async recordingOwner(
    recordingId: string,
  ): Promise<string | undefined> {
    const [row] = await this.database
      .select({ ownerId: journalDays.userId })
      .from(recordings)
      .innerJoin(contributions, eq(contributions.id, recordings.contributionId))
      .innerJoin(journalDays, eq(journalDays.id, contributions.journalDayId))
      .where(eq(recordings.id, recordingId))
      .limit(1);
    return row?.ownerId;
  }

  public async journalDayOwner(
    journalDayId: string,
  ): Promise<string | undefined> {
    const [row] = await this.database
      .select({ ownerId: journalDays.userId })
      .from(journalDays)
      .where(eq(journalDays.id, journalDayId))
      .limit(1);
    return row?.ownerId;
  }

  public async get(ownerId: string, providerId: string) {
    const [row] = await this.database
      .select({
        configuration: providerConfigurations,
        credential: providerCredentials,
      })
      .from(providerConfigurations)
      .leftJoin(
        providerCredentials,
        and(
          eq(providerCredentials.ownerId, providerConfigurations.ownerId),
          eq(providerCredentials.providerId, providerConfigurations.providerId),
        ),
      )
      .where(
        and(
          eq(providerConfigurations.ownerId, ownerId),
          eq(providerConfigurations.providerId, providerId),
        ),
      )
      .limit(1);
    return row;
  }
}
