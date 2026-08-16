import { asc } from 'drizzle-orm';

import type { RepositoryContext } from '../client.js';
import {
  processorInstallations,
  queueConfigurations,
  schedules,
} from '../schema.js';

export interface QueueConfigurationRecord {
  readonly deadLetterQueue: string | null;
  readonly expireInSeconds: number;
  readonly name: string;
  readonly payloadSchemaVersion: number;
  readonly retentionSeconds: number;
  readonly retryBackoff: boolean;
  readonly retryDelaySeconds: number;
  readonly retryLimit: number;
}

export interface ProcessorInstallationRecord {
  readonly enabled: boolean;
  readonly key: string;
  readonly requirementMode: 'optional' | 'required';
}

export interface ScheduleRecord {
  readonly cronExpression: string;
  readonly enabled: boolean;
  readonly key: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly payloadSchemaVersion: number;
  readonly queueName: string;
  readonly timeZone: string;
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
        deadLetterQueue: queueConfigurations.deadLetterQueue,
        expireInSeconds: queueConfigurations.expireInSeconds,
        name: queueConfigurations.name,
        payloadSchemaVersion: queueConfigurations.payloadSchemaVersion,
        retentionSeconds: queueConfigurations.retentionSeconds,
        retryBackoff: queueConfigurations.retryBackoff,
        retryDelaySeconds: queueConfigurations.retryDelaySeconds,
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
        cronExpression: schedules.cronExpression,
        enabled: schedules.enabled,
        key: schedules.key,
        payload: schedules.payload,
        payloadSchemaVersion: schedules.payloadSchemaVersion,
        queueName: schedules.queueName,
        timeZone: schedules.timeZone,
      })
      .from(schedules)
      .orderBy(asc(schedules.key));
  }
}
