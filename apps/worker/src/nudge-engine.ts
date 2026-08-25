import {
  NudgeRepository,
  QueueJobError,
  queueNames,
  registerQueueWorker,
  type CanonicalJobHandler,
  type CanonicalJobInput,
  type DatabaseClient,
  type QueueJobPayload,
} from '@journal/database';
import type { PgBoss } from 'pg-boss';

export const NUDGE_DIGEST_OPERATION = 'nudge_digest';

/** Scheduled identifier-only handler; all eligible state is reloaded in SQL. */
export class NudgeDigestJobHandler implements CanonicalJobHandler<true> {
  readonly #repository: NudgeRepository;

  public constructor(
    database: DatabaseClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new NudgeRepository(database.database);
  }

  public load(payload: QueueJobPayload): Promise<CanonicalJobInput<true>> {
    if (
      payload.operation !== NUDGE_DIGEST_OPERATION ||
      payload.identifiers.scheduleKey !== 'nudges.digest'
    )
      throw new QueueJobError('permanent', 'Unsupported nudge digest payload.');
    return Promise.resolve({ input: true, state: 'runnable' });
  }

  public async execute(_input: true, signal: AbortSignal): Promise<void> {
    if (signal.aborted) signal.throwIfAborted();
    await this.#repository.runSchedule(this.now());
  }
}

export function registerNudgeDigestConsumer(input: {
  readonly boss: PgBoss;
  readonly database: DatabaseClient;
}): Promise<string> {
  return registerQueueWorker({
    boss: input.boss,
    queueName: queueNames.notifications,
    handler: new NudgeDigestJobHandler(input.database),
  });
}
