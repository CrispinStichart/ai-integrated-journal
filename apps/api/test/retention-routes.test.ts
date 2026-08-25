import { RetentionConflictError } from '@journal/database';
import { silentLogger } from '@journal/observability';
import type {
  PermanentDeletionPreview,
  PermanentDeletionResource,
} from '@journal/contracts';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

import { createApiApp } from '../src/app.js';
import type { RetentionService } from '../src/retention-service.js';

const OWNER_ID = '019d2b3c-4000-7000-8000-000000000001';
const CONTRIBUTION_ID = '019d2b3c-4000-7000-8000-000000000002';
const DELETION_ID = '019d2b3c-4000-7000-8000-000000000003';

const deletion: PermanentDeletionResource = {
  id: DELETION_ID,
  target: { entityKind: 'contribution', entityId: CONTRIBUTION_ID },
  status: 'pending',
  generation: 1,
  requestedAt: '2026-08-25T00:00:00.000Z',
  eligibleAt: '2026-07-31T00:00:00.000Z',
  attempts: 0,
  backupCheckpoint: 'not_configured',
  backupWarning: 'No verified post-deletion restore point exists.',
};

function service(): RetentionService {
  return {
    preview: vi.fn(async (_ownerId, target) => {
      const preview: PermanentDeletionPreview = {
        target: { entityKind: target.entityKind, entityId: target.entityId },
        softDeletedAt: '2026-07-01T00:00:00.000Z',
        eligibleAt: '2026-07-31T00:00:00.000Z',
        eligible: true,
        affectedContributionCount: 1,
        affectedRecordingCount: 0,
        impacts: [
          {
            facet: 'database',
            action: 'delete',
            detail: 'Delete database rows.',
          },
        ],
        warnings: ['This cannot be undone.'],
      };
      return preview;
    }),
    request: vi.fn(async () => ({
      deletion,
      replayed: false,
    })),
    get: vi.fn(async () => undefined),
    tombstones: vi.fn(async () => ({
      items: [],
      latestGeneration: 0,
      hasMore: false,
    })),
    acknowledgeBrowserPurge: vi.fn(async () => undefined),
  };
}

function app(retentionService: RetentionService, authenticated = true) {
  return createApiApp({
    authenticator: {
      authenticate: vi.fn(async () =>
        authenticated ? { ownerId: OWNER_ID } : undefined,
      ),
    },
    eventFeed: {
      poll: vi.fn(async () => []),
      watch: vi.fn(async () => () => undefined),
    },
    healthProbes: [],
    logger: silentLogger,
    retentionService,
  });
}

describe('retention routes', () => {
  it('[RET-005][RET-006][SEC-008] scopes impact preview and explicit permanent confirmation to the authenticated owner', async () => {
    const retention = service();
    const preview = await request(app(retention))
      .post('/api/v1/retention/permanent-deletions/preview')
      .send({ entityKind: 'contribution', entityId: CONTRIBUTION_ID })
      .expect(200);
    expect(preview.body).toMatchObject({
      eligible: true,
      affectedContributionCount: 1,
    });
    expect(retention.preview).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ entityId: CONTRIBUTION_ID }),
    );

    await request(app(retention))
      .post('/api/v1/retention/permanent-deletions')
      .send({
        entityKind: 'contribution',
        entityId: CONTRIBUTION_ID,
        confirmation: 'delete',
      })
      .expect(400);
    await request(app(retention))
      .post('/api/v1/retention/permanent-deletions')
      .send({
        entityKind: 'contribution',
        entityId: CONTRIBUTION_ID,
        confirmation: 'PERMANENTLY DELETE',
      })
      .expect(202);
    expect(retention.request).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({ entityId: CONTRIBUTION_ID }),
      expect.any(String),
    );
  });

  it('[RET-006][SEC-001] does not disclose retention targets to unauthenticated or ineligible requests', async () => {
    await request(app(service(), false))
      .get('/api/v1/retention/tombstones')
      .expect(401);
    const retention = service();
    vi.mocked(retention.preview).mockRejectedValueOnce(
      new RetentionConflictError('Grace period remains active.'),
    );
    const response = await request(app(retention))
      .post('/api/v1/retention/permanent-deletions/preview')
      .send({ entityKind: 'contribution', entityId: CONTRIBUTION_ID })
      .expect(409);
    expect(response.body).toMatchObject({ code: 'retention_conflict' });
  });

  it('[RET-006][RET-007] pages the owner tombstone ledger and acknowledges only an explicit applied generation', async () => {
    const retention = service();
    await request(app(retention))
      .get('/api/v1/retention/tombstones?afterGeneration=4&limit=50')
      .expect(200);
    expect(retention.tombstones).toHaveBeenCalledWith(OWNER_ID, 4, 50);

    await request(app(retention))
      .post('/api/v1/retention/browser-purge-acknowledgements')
      .send({ generation: 4 })
      .expect(204);
    expect(retention.acknowledgeBrowserPurge).toHaveBeenCalledWith(OWNER_ID, 4);
    await request(app(retention))
      .post('/api/v1/retention/browser-purge-acknowledgements')
      .send({ generation: -1 })
      .expect(400);
  });
});
