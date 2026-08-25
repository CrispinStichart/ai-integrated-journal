import {
  type PermanentDeletionPreview,
  type PermanentDeletionRequest,
  type PermanentDeletionResource,
} from '@journal/contracts';
import {
  RetentionRepository,
  createQueueJobPayload,
  queueNames,
} from '@journal/database';
import { createUuidV7, retentionMatrix } from '@journal/domain';
import type { PgBoss } from 'pg-boss';

const BACKUP_WARNING =
  'No backup repository is configured. Permanent deletion is complete in live storage, but no verified post-deletion restore point exists.';

export interface RetentionService {
  preview(
    ownerId: string,
    target: PermanentDeletionRequest,
  ): Promise<PermanentDeletionPreview>;
  request(
    ownerId: string,
    target: PermanentDeletionRequest,
    correlationId: string,
  ): Promise<{ deletion: PermanentDeletionResource; replayed: boolean }>;
  get(
    ownerId: string,
    id: string,
  ): Promise<PermanentDeletionResource | undefined>;
  tombstones(
    ownerId: string,
    afterGeneration: number,
    limit: number,
  ): Promise<{
    items: Array<{
      entityKind: PermanentDeletionRequest['entityKind'];
      entityId: string;
      deletedAt: string;
      generation: number;
    }>;
    latestGeneration: number;
    hasMore: boolean;
  }>;
  acknowledgeBrowserPurge(ownerId: string, generation: number): Promise<void>;
}

export class PostgresRetentionService implements RetentionService {
  readonly #repository: RetentionRepository;

  public constructor(
    database: ConstructorParameters<typeof RetentionRepository>[0],
    private readonly boss: PgBoss,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.#repository = new RetentionRepository(database);
  }

  public async preview(
    ownerId: string,
    target: PermanentDeletionRequest,
  ): Promise<PermanentDeletionPreview> {
    const preview = await this.#repository.preview(
      ownerId,
      target.entityKind,
      target.entityId,
      this.now(),
    );
    const matrix = retentionMatrix[target.entityKind];
    return {
      target: { entityKind: target.entityKind, entityId: target.entityId },
      softDeletedAt: preview.softDeletedAt.toISOString(),
      eligibleAt: preview.eligibleAt.toISOString(),
      eligible: preview.eligible,
      affectedContributionCount: preview.affectedContributionCount,
      affectedRecordingCount: preview.affectedRecordingCount,
      impacts: Object.entries(matrix).map(([facet, action]) => ({
        facet: facet as keyof typeof matrix,
        action,
        detail: `${impactVerb(action)} ${facet.replaceAll('_', ' ')}.`,
      })),
      warnings: [
        'This stable identity can never be restored or reused after the tombstone is committed.',
        'Downloaded exports are outside system control.',
        'Encrypted historical backups may retain deleted bytes until their configured snapshot retention expires.',
      ],
    };
  }

  public async request(
    ownerId: string,
    target: PermanentDeletionRequest,
    correlationId: string,
  ) {
    const result = await this.#repository.request({
      id: createUuidV7<'permanent-deletion'>(),
      tombstoneId: createUuidV7<'deletion-tombstone'>(),
      ownerId,
      entityKind: target.entityKind,
      entityId: target.entityId,
      correlationId,
      requestedAt: this.now(),
    });
    if (!result.replayed) {
      const payload = createQueueJobPayload({
        identifiers: { requestId: result.deletion.id },
        operation: 'retention_request',
        queueName: queueNames.maintenance,
      });
      await this.boss.send(queueNames.maintenance, payload, {
        singletonKey: payload.fingerprint,
      });
    }
    return {
      deletion: mapDeletion(result.deletion),
      replayed: result.replayed,
    };
  }

  public async get(ownerId: string, id: string) {
    const row = await this.#repository.get(ownerId, id);
    return row === undefined ? undefined : mapDeletion(row);
  }

  public async tombstones(
    ownerId: string,
    afterGeneration: number,
    limit: number,
  ) {
    const page = await this.#repository.tombstones(
      ownerId,
      afterGeneration,
      limit,
    );
    return {
      items: page.items.map((item) => ({
        entityKind: item.entityKind,
        entityId: item.entityId,
        deletedAt: item.deletedAt.toISOString(),
        generation: item.generation,
      })),
      latestGeneration: page.latestGeneration,
      hasMore: page.hasMore,
    };
  }

  public acknowledgeBrowserPurge(ownerId: string, generation: number) {
    return this.#repository.acknowledgeBrowserPurge(ownerId, generation);
  }
}

function impactVerb(
  action: 'delete' | 'invalidate' | 'retain' | 'retain_metadata',
): string {
  if (action === 'delete') return 'Permanently delete';
  if (action === 'invalidate') return 'Invalidate';
  if (action === 'retain') return 'Retain unaffected';
  return 'Retain content-free metadata for';
}

function mapDeletion(
  row: Awaited<ReturnType<RetentionRepository['get']>> extends infer T
    ? Exclude<T, undefined>
    : never,
): PermanentDeletionResource {
  return {
    id: row.id,
    target: { entityKind: row.entityKind, entityId: row.entityId },
    status: row.status,
    generation: row.generation,
    requestedAt: row.requestedAt.toISOString(),
    eligibleAt: row.eligibleAt.toISOString(),
    ...(row.startedAt === null
      ? {}
      : { startedAt: row.startedAt.toISOString() }),
    ...(row.completedAt === null
      ? {}
      : { completedAt: row.completedAt.toISOString() }),
    attempts: row.attempts,
    backupCheckpoint: row.backupCheckpoint as
      'not_configured' | 'pending' | 'committed',
    ...(row.backupCheckpoint === 'not_configured'
      ? { backupWarning: BACKUP_WARNING }
      : {}),
    ...(row.errorCode === null ? {} : { errorCode: row.errorCode }),
  };
}
