import type {
  NudgeActionRequest,
  NudgeDayResource,
  NudgePreference,
  SseEventEnvelope,
  UpdateNudgePreferenceRequest,
} from '@journal/contracts';
import { NudgeRepository, type JournalDatabase } from '@journal/database';
import { createUuidV7 } from '@journal/domain';

export interface NudgeService {
  getDay(ownerId: string, journalDate: string): Promise<NudgeDayResource>;
  getPreferences(ownerId: string): Promise<NudgePreference>;
  act(
    ownerId: string,
    digestId: string,
    expectedRevision: number,
    request: NudgeActionRequest,
    idempotencyKey: string,
    correlationId: string,
  ): Promise<
    Readonly<{
      day: NudgeDayResource;
      responseContributionId: string;
      replayed: boolean;
    }>
  >;
  updatePreferences(
    ownerId: string,
    expectedRevision: number,
    request: UpdateNudgePreferenceRequest,
    idempotencyKey: string,
  ): Promise<Readonly<{ preference: NudgePreference; replayed: boolean }>>;
}

export type NudgeEventPublisher = (
  ownerId: string,
  event: SseEventEnvelope,
) => void;

export class PostgresNudgeService implements NudgeService {
  readonly #repository: NudgeRepository;

  public constructor(
    database: JournalDatabase,
    private readonly publish?: NudgeEventPublisher,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new NudgeRepository(database);
  }

  public getDay(ownerId: string, journalDate: string) {
    return this.#repository.getDay(ownerId, journalDate);
  }

  public getPreferences(ownerId: string) {
    return this.#repository.getPreferences(ownerId);
  }

  public async act(
    ownerId: string,
    digestId: string,
    expectedRevision: number,
    request: NudgeActionRequest,
    idempotencyKey: string,
    correlationId: string,
  ) {
    const result = await this.#repository.act({
      ownerId,
      digestId,
      expectedRevision,
      request,
      idempotencyKey,
      correlationId,
      now: this.now(),
    });
    const resolvedDay = await this.#repository.getDay(
      ownerId,
      result.journalDate,
    );
    this.publish?.(ownerId, {
      eventId: createUuidV7<'event'>(),
      eventType: 'nudge.updated',
      schemaVersion: 1,
      occurredAt: this.now().toISOString(),
      payload: { digestId, journalDate: resolvedDay.journalDate },
    });
    return {
      day: resolvedDay,
      responseContributionId: result.responseContributionId,
      replayed: result.replayed,
    };
  }

  public updatePreferences(
    ownerId: string,
    expectedRevision: number,
    request: UpdateNudgePreferenceRequest,
    idempotencyKey: string,
  ) {
    return this.#repository.updatePreferences({
      ownerId,
      expectedRevision,
      request,
      idempotencyKey,
      now: this.now(),
    });
  }
}
