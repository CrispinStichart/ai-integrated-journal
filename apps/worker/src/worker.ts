import { assertQueueFoundation, type DatabaseClient } from '@journal/database';
import type { ContentSafeLogger } from '@journal/observability';
import { processorsPackageName } from '@journal/processors';
import type { PgBoss } from 'pg-boss';

export interface WorkerStatus {
  readonly dependencies: readonly string[];
  readonly service: '@journal/worker';
  readonly status: 'ready' | 'starting' | 'stopped';
}

export function getWorkerStatus(
  status: WorkerStatus['status'] = 'ready',
): WorkerStatus {
  return Object.freeze({
    dependencies: [processorsPackageName],
    service: '@journal/worker',
    status,
  });
}

export interface WorkerRuntimeOptions {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
  readonly logger: ContentSafeLogger;
  readonly registerConsumers?: (boss: PgBoss) => Promise<void>;
  readonly shutdownGraceMilliseconds?: number;
}

/** Owns queue startup, consumer registration, and bounded graceful shutdown. */
export class WorkerRuntime {
  private state: WorkerStatus['status'] = 'stopped';
  private stopping: Promise<void> | undefined;

  public constructor(private readonly options: WorkerRuntimeOptions) {}

  public getStatus(): WorkerStatus {
    return getWorkerStatus(this.state);
  }

  public async start(): Promise<void> {
    if (this.state !== 'stopped') return;
    this.state = 'starting';
    await assertQueueFoundation(this.options.boss, this.options.database);
    await this.options.boss.start();
    await this.options.registerConsumers?.(this.options.boss);
    this.state = 'ready';
    this.options.logger.info('Worker ready');
  }

  public stop(): Promise<void> {
    this.stopping ??= (async () => {
      this.state = 'stopped';
      this.options.logger.info('Worker shutdown started');
      await this.options.boss.stop({
        graceful: true,
        timeout: this.options.shutdownGraceMilliseconds ?? 10_000,
      });
      await this.options.database.close();
      this.options.logger.info('Worker shutdown completed');
    })();
    return this.stopping;
  }
}
