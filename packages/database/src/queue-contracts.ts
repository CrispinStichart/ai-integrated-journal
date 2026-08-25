import { createHash } from 'node:crypto';

import type { Queue, WorkOptions } from 'pg-boss';

export const EXPECTED_PG_BOSS_SCHEMA_VERSION = 37;
export const QUEUE_PAYLOAD_SCHEMA_VERSION = 1;

export const queueNames = {
  backup: 'journal.backup',
  cleanup: 'journal.cleanup',
  deadLetter: 'journal.dead-letter',
  groundedAnswers: 'journal.grounded-answers',
  maintenance: 'journal.maintenance',
  notifications: 'journal.notifications',
  processing: 'journal.processing',
  search: 'journal.search',
  transcription: 'journal.transcription',
} as const;

export type QueueName = (typeof queueNames)[keyof typeof queueNames];

export interface QueueDefinition {
  readonly name: QueueName;
  readonly payloadSchemaVersion: number;
  readonly queueOptions: Readonly<Omit<Queue, 'name'>>;
  readonly workOptions: Readonly<WorkOptions>;
}

const commonWorkOptions = {
  batchSize: 1,
  heartbeatRefreshSeconds: 30,
  includeMetadata: false,
  notifyPollingIntervalSeconds: 5,
  perJobResults: true,
  pollingIntervalSeconds: 2,
} as const;

function queueDefinition(
  name: QueueName,
  options: Readonly<Omit<Queue, 'name'>>,
  localConcurrency: number,
): QueueDefinition {
  return Object.freeze({
    name,
    payloadSchemaVersion: QUEUE_PAYLOAD_SCHEMA_VERSION,
    queueOptions: Object.freeze({
      heartbeatSeconds: 60,
      notify: true,
      ...options,
    }),
    workOptions: Object.freeze({
      ...commonWorkOptions,
      localConcurrency,
    }),
  });
}

export const queueDefinitions: Readonly<Record<QueueName, QueueDefinition>> =
  Object.freeze({
    [queueNames.processing]: queueDefinition(
      queueNames.processing,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 14 * 24 * 60 * 60,
        expireInSeconds: 15 * 60,
        retentionSeconds: 14 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 30,
        retryLimit: 5,
      },
      2,
    ),
    [queueNames.transcription]: queueDefinition(
      queueNames.transcription,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        expireInSeconds: 2 * 60 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 30,
        retryLimit: 5,
      },
      1,
    ),
    [queueNames.cleanup]: queueDefinition(
      queueNames.cleanup,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        expireInSeconds: 30 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 30,
        retryLimit: 5,
      },
      2,
    ),
    [queueNames.maintenance]: queueDefinition(
      queueNames.maintenance,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 14 * 24 * 60 * 60,
        expireInSeconds: 30 * 60,
        retentionSeconds: 14 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 60,
        retryLimit: 3,
      },
      1,
    ),
    [queueNames.notifications]: queueDefinition(
      queueNames.notifications,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 7 * 24 * 60 * 60,
        expireInSeconds: 5 * 60,
        retentionSeconds: 7 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 60,
        retryLimit: 3,
      },
      2,
    ),
    [queueNames.search]: queueDefinition(
      queueNames.search,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 14 * 24 * 60 * 60,
        expireInSeconds: 30 * 60,
        retentionSeconds: 14 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 30,
        retryLimit: 5,
      },
      2,
    ),
    [queueNames.groundedAnswers]: queueDefinition(
      queueNames.groundedAnswers,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        expireInSeconds: 2 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 30,
        retryLimit: 3,
      },
      1,
    ),
    [queueNames.backup]: queueDefinition(
      queueNames.backup,
      {
        deadLetter: queueNames.deadLetter,
        deleteAfterSeconds: 30 * 24 * 60 * 60,
        expireInSeconds: 4 * 60 * 60,
        retentionSeconds: 30 * 24 * 60 * 60,
        retryBackoff: true,
        retryDelay: 5 * 60,
        retryLimit: 2,
      },
      1,
    ),
    [queueNames.deadLetter]: queueDefinition(
      queueNames.deadLetter,
      {
        deleteAfterSeconds: 90 * 24 * 60 * 60,
        expireInSeconds: 24 * 60 * 60 - 1,
        retentionSeconds: 90 * 24 * 60 * 60,
        retryBackoff: false,
        retryDelay: 0,
        retryLimit: 0,
      },
      1,
    ),
  });

export const allQueueDefinitions = Object.freeze(
  Object.values(queueDefinitions),
);

export interface QueueJobPayload extends Readonly<Record<string, unknown>> {
  readonly fingerprint: string;
  readonly identifiers: Readonly<Record<string, string>>;
  readonly operation: string;
  readonly schemaVersion: number;
}

function sortedIdentifiers(
  identifiers: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(identifiers).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

export function createJobFingerprint(input: {
  readonly identifiers: Readonly<Record<string, string>>;
  readonly operation: string;
  readonly queueName: QueueName;
}): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        identifiers: sortedIdentifiers(input.identifiers),
        operation: input.operation,
        queueName: input.queueName,
        schemaVersion: QUEUE_PAYLOAD_SCHEMA_VERSION,
      }),
    )
    .digest('hex');
}

export function createQueueJobPayload(input: {
  readonly identifiers: Readonly<Record<string, string>>;
  readonly operation: string;
  readonly queueName: QueueName;
}): QueueJobPayload {
  const identifiers = Object.freeze(sortedIdentifiers(input.identifiers));
  return Object.freeze({
    fingerprint: createJobFingerprint({ ...input, identifiers }),
    identifiers,
    operation: input.operation,
    schemaVersion: QUEUE_PAYLOAD_SCHEMA_VERSION,
  });
}

export class InvalidQueuePayloadError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'InvalidQueuePayloadError';
  }
}

/** Rejects content-bearing or version-incompatible payloads at the worker boundary. */
export function parseQueueJobPayload(
  queueName: QueueName,
  value: unknown,
): QueueJobPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new InvalidQueuePayloadError('Queue payload must be an object');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const keys = Object.keys(record).sort();
  if (
    keys.join(',') !==
    ['fingerprint', 'identifiers', 'operation', 'schemaVersion'].join(',')
  ) {
    throw new InvalidQueuePayloadError(
      'Queue payload contains unsupported fields',
    );
  }
  if (
    record.schemaVersion !== queueDefinitions[queueName].payloadSchemaVersion
  ) {
    throw new InvalidQueuePayloadError(
      'Unsupported queue payload schema version',
    );
  }
  if (typeof record.operation !== 'string' || record.operation.length === 0) {
    throw new InvalidQueuePayloadError('Queue operation must be non-empty');
  }
  if (
    typeof record.identifiers !== 'object' ||
    record.identifiers === null ||
    Array.isArray(record.identifiers)
  ) {
    throw new InvalidQueuePayloadError('Queue identifiers must be an object');
  }
  const identifiers = record.identifiers as Readonly<Record<string, unknown>>;
  if (
    Object.entries(identifiers).some(
      ([key, identifier]) =>
        !/(?:Id|Key)$/u.test(key) ||
        typeof identifier !== 'string' ||
        identifier.length === 0 ||
        identifier.length > 200,
    )
  ) {
    throw new InvalidQueuePayloadError(
      'Queue identifiers must use Id/Key names and bounded non-empty string values',
    );
  }
  const normalizedIdentifiers = Object.fromEntries(
    Object.entries(identifiers).map(([key, identifier]) => [
      key,
      identifier as string,
    ]),
  );
  const expectedFingerprint = createJobFingerprint({
    identifiers: normalizedIdentifiers,
    operation: record.operation,
    queueName,
  });
  if (record.fingerprint !== expectedFingerprint) {
    throw new InvalidQueuePayloadError(
      'Queue fingerprint does not match payload',
    );
  }
  return createQueueJobPayload({
    identifiers: normalizedIdentifiers,
    operation: record.operation,
    queueName,
  });
}
