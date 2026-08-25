import { describe, expect, it } from 'vitest';

import {
  allQueueDefinitions,
  classifyQueueError,
  createQueueJobPayload,
  InvalidQueuePayloadError,
  parseQueueJobPayload,
  queueDefinitions,
  queueNames,
  QueueJobError,
} from '../src/index.js';

describe('WORKER queue contracts', () => {
  it('[STATE-004] creates stable fingerprints independent of identifier order', () => {
    const first = createQueueJobPayload({
      identifiers: { revisionId: 'revision-1', runId: 'run-1' },
      operation: 'process_revision',
      queueName: queueNames.processing,
    });
    const second = createQueueJobPayload({
      identifiers: { runId: 'run-1', revisionId: 'revision-1' },
      operation: 'process_revision',
      queueName: queueNames.processing,
    });

    expect(first).toEqual(second);
    expect(first.fingerprint).toMatch(/^[a-f\d]{64}$/u);
    expect(parseQueueJobPayload(queueNames.processing, first)).toEqual(first);
  });

  it('[ARCH-005] rejects content-bearing, tampered, and incompatible payloads', () => {
    const payload = createQueueJobPayload({
      identifiers: { runId: 'run-1' },
      operation: 'process_revision',
      queueName: queueNames.processing,
    });

    expect(() =>
      parseQueueJobPayload(queueNames.processing, {
        ...payload,
        text: 'must never enter a job',
      }),
    ).toThrow(InvalidQueuePayloadError);
    expect(() =>
      parseQueueJobPayload(queueNames.processing, {
        ...payload,
        identifiers: { text: 'must not masquerade as an identifier' },
      }),
    ).toThrow('Id/Key');
    expect(() =>
      parseQueueJobPayload(queueNames.processing, {
        ...payload,
        fingerprint: 'tampered',
      }),
    ).toThrow('fingerprint');
    expect(() =>
      parseQueueJobPayload(queueNames.processing, {
        ...payload,
        schemaVersion: 2,
      }),
    ).toThrow('schema version');
  });

  it('[STATE-003][STATE-004] shares bounded retry, heartbeat, concurrency, and dead-letter policy', () => {
    expect(allQueueDefinitions).toHaveLength(9);
    expect(
      allQueueDefinitions.every(
        ({ queueOptions }) => queueOptions.heartbeatSeconds === 60,
      ),
    ).toBe(true);
    expect(
      allQueueDefinitions.every(
        ({ workOptions }) =>
          (workOptions.localConcurrency ?? 0) > 0 &&
          (workOptions.localConcurrency ?? 0) <= 2,
      ),
    ).toBe(true);
    expect(queueDefinitions[queueNames.processing].queueOptions).toMatchObject({
      deadLetter: queueNames.deadLetter,
      retryBackoff: true,
      retryLimit: 5,
    });
    expect(
      queueDefinitions[queueNames.transcription].queueOptions,
    ).toMatchObject({
      deadLetter: queueNames.deadLetter,
      retryBackoff: true,
      retryLimit: 5,
    });
    expect(queueDefinitions[queueNames.cleanup].queueOptions).toMatchObject({
      deadLetter: queueNames.deadLetter,
      retryBackoff: true,
      retryLimit: 5,
    });
    expect(
      queueDefinitions[queueNames.groundedAnswers].queueOptions,
    ).toMatchObject({
      deadLetter: queueNames.deadLetter,
      retryBackoff: true,
      retryLimit: 3,
    });
    expect(
      queueDefinitions[queueNames.deadLetter].queueOptions.retryLimit,
    ).toBe(0);
  });

  it('[STATE-003] classifies explicit permanent and canceled failures while defaulting unknown failures to transient', () => {
    expect(classifyQueueError(new Error('network unavailable'))).toBe(
      'transient',
    );
    expect(classifyQueueError(new QueueJobError('permanent', 'invalid'))).toBe(
      'permanent',
    );
    expect(classifyQueueError(new QueueJobError('canceled', 'requested'))).toBe(
      'canceled',
    );
  });
});
