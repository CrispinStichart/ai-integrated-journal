import { asc } from 'drizzle-orm';

import type { RepositoryContext } from '../client.js';
import {
  processorInstallations,
  queueConfigurations,
  schedules,
} from '../schema.js';

export interface QueueConfigurationRecord {
  readonly name: string;
  readonly payloadSchemaVersion: number;
  readonly retryLimit: number;
}

export interface ProcessorInstallationRecord {
  readonly enabled: boolean;
  readonly key: string;
  readonly requirementMode: 'optional' | 'required';
}

export interface ScheduleRecord {
  readonly enabled: boolean;
  readonly key: string;
  readonly queueName: string;
}

/**
 * Foundation read model. The caller supplies either the database or its active
 * transaction; Drizzle rows remain private to this package.
 */
export class FoundationRepository {
  public constructor(private readonly context: RepositoryContext) {}

  public async listQueueConfigurations(): Promise<QueueConfigurationRecord[]> {
    return this.context
      .select({
        name: queueConfigurations.name,
        payloadSchemaVersion: queueConfigurations.payloadSchemaVersion,
        retryLimit: queueConfigurations.retryLimit,
      })
      .from(queueConfigurations)
      .orderBy(asc(queueConfigurations.name));
  }

  public async listProcessorInstallations(): Promise<
    ProcessorInstallationRecord[]
  > {
    return this.context
      .select({
        enabled: processorInstallations.enabled,
        key: processorInstallations.key,
        requirementMode: processorInstallations.requirementMode,
      })
      .from(processorInstallations)
      .orderBy(asc(processorInstallations.key));
  }

  public async listSchedules(): Promise<ScheduleRecord[]> {
    return this.context
      .select({
        enabled: schedules.enabled,
        key: schedules.key,
        queueName: schedules.queueName,
      })
      .from(schedules)
      .orderBy(asc(schedules.key));
  }
}
