import type { ArtifactResource } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import {
  ArtifactPreconditionError,
  type ArtifactService,
} from '../src/artifact-service.js';
import { createInMemoryEventFeed } from '../src/events.js';

const OWNER_ID = '019c5b90-0000-7000-8000-000000000020';
const DAY_ID = '019c5b90-0000-7000-8000-000000000021';
const ARTIFACT_ID = '019c5b90-0000-7000-8000-000000000022';
const PROCESSOR_ID = '019c5b90-0000-7000-8000-000000000023';
const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000024';
const RESULT_ID = '019c5b90-0000-7000-8000-000000000025';
const NOW = '2026-08-23T18:00:00.000Z';

const artifact: ArtifactResource = {
  id: ARTIFACT_ID,
  processorId: PROCESSOR_ID,
  journalDayId: DAY_ID,
  logicalKey: 'string:water',
  kind: 'observation',
  revision: 2,
  active: true,
  deleted: false,
  authority: 'manual',
  payload: { amount: 2 },
  manualOperation: 'correct',
  overridePaths: ['/amount'],
  candidates: [],
  history: [
    {
      id: RESULT_ID,
      revision: 1,
      authority: 'manual',
      lifecycle: 'active',
      payload: { amount: 2 },
      payloadHash: 'a'.repeat(64),
      manualOperation: 'correct',
      overridePaths: ['/amount'],
      createdAt: NOW,
    },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

function service(): ArtifactService {
  return {
    list: vi.fn(async () => [artifact]),
    edit: vi.fn(async () => ({ artifacts: [artifact], replayed: false })),
    merge: vi.fn(async () => ({ artifacts: [artifact], replayed: false })),
  };
}

function app(artifactService: ArtifactService) {
  return createApiApp({
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid'
          ? { ownerId: OWNER_ID }
          : undefined,
    },
    artifactService,
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
  });
}

describe('manual artifact editing API', () => {
  it('[PROV-004][SEC-002] requires ownership authentication before listing effective artifacts and history', async () => {
    const artifactService = service();
    await request(app(artifactService))
      .get(`/api/v1/journal-days/${DAY_ID}/artifacts`)
      .expect(401);
    const response = await request(app(artifactService))
      .get(`/api/v1/journal-days/${DAY_ID}/artifacts`)
      .set('authorization', 'Bearer valid')
      .expect(200);
    expect(response.body.items[0]).toMatchObject({
      authority: 'manual',
      overridePaths: ['/amount'],
      history: [{ authority: 'manual' }],
    });
    expect(artifactService.list).toHaveBeenCalledWith(OWNER_ID, DAY_ID);
  });

  it('[EDIT-006][STATE-004] requires conditional idempotency metadata and returns the next strong ETag', async () => {
    const artifactService = service();
    await request(app(artifactService))
      .post(`/api/v1/artifacts/${ARTIFACT_ID}/edits`)
      .set('authorization', 'Bearer valid')
      .send({ operation: 'confirm' })
      .expect(428);
    const response = await request(app(artifactService))
      .post(`/api/v1/artifacts/${ARTIFACT_ID}/edits`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'confirm-artifact-1')
      .set('if-match', '"artifact-1"')
      .send({ operation: 'confirm' })
      .expect(200)
      .expect('etag', '"artifact-2"');
    expect(response.body.idempotency).toEqual({
      key: 'confirm-artifact-1',
      replayed: false,
    });
    expect(artifactService.edit).toHaveBeenCalledWith(
      OWNER_ID,
      ARTIFACT_ID,
      1,
      { operation: 'confirm' },
      'confirm-artifact-1',
      CORRELATION_ID,
    );
  });

  it('[FOOD-007][EDIT-006] validates artifact-set ETags for atomic merge', async () => {
    const artifactService = service();
    const secondId = '019c5b90-0000-7000-8000-000000000026';
    const resultId = '019c5b90-0000-7000-8000-000000000027';
    await request(app(artifactService))
      .post('/api/v1/artifacts/merge')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'merge-artifacts-1')
      .set('if-match', `"artifacts-${ARTIFACT_ID}:2"`)
      .send({
        sourceArtifactIds: [ARTIFACT_ID, secondId],
        result: {
          artifactId: resultId,
          logicalKey: 'manual:merge:test',
          payload: { amount: 3 },
        },
      })
      .expect(400);
    await request(app(artifactService))
      .post('/api/v1/artifacts/merge')
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'merge-artifacts-2')
      .set('if-match', `"artifacts-${ARTIFACT_ID}:2,${secondId}:1"`)
      .send({
        sourceArtifactIds: [ARTIFACT_ID, secondId],
        result: {
          artifactId: resultId,
          logicalKey: 'manual:merge:test',
          payload: { amount: 3 },
        },
      })
      .expect(200);
    expect(artifactService.merge).toHaveBeenCalledWith(
      OWNER_ID,
      { [ARTIFACT_ID]: 2, [secondId]: 1 },
      expect.objectContaining({ sourceArtifactIds: [ARTIFACT_ID, secondId] }),
      'merge-artifacts-2',
      CORRELATION_ID,
    );
  });

  it('[EDIT-006] maps stale artifact ETags to a stable precondition problem', async () => {
    const artifactService = service();
    vi.mocked(artifactService.edit).mockRejectedValueOnce(
      new ArtifactPreconditionError(),
    );
    const response = await request(app(artifactService))
      .post(`/api/v1/artifacts/${ARTIFACT_ID}/edits`)
      .set('authorization', 'Bearer valid')
      .set('idempotency-key', 'stale-artifact-1')
      .set('if-match', '"artifact-1"')
      .send({ operation: 'delete' })
      .expect(412);
    expect(response.body.code).toBe('artifact_precondition_failed');
  });
});
