// @vitest-environment jsdom

import type { ArtifactResource } from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ArtifactApiError,
  editArtifact,
  listArtifacts,
  mergeArtifacts,
} from '../src/artifact/api';

const DAY_ID = '019c5b90-0000-7000-8000-000000000021';
const ARTIFACT_ID = '019c5b90-0000-7000-8000-000000000022';
const SECOND_ID = '019c5b90-0000-7000-8000-000000000023';
const RESULT_ID = '019c5b90-0000-7000-8000-000000000024';
const artifact: ArtifactResource = {
  id: ARTIFACT_ID,
  processorId: SECOND_ID,
  journalDayId: DAY_ID,
  logicalKey: 'string:item',
  kind: 'observation',
  revision: 2,
  active: true,
  deleted: false,
  authority: 'generated',
  payload: { value: 1 },
  overridePaths: [],
  candidates: [],
  evidence: [],
  history: [],
  createdAt: '2026-08-23T18:00:00.000Z',
  updatedAt: '2026-08-23T18:00:00.000Z',
};
const response = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => vi.unstubAllGlobals());

describe('artifact API client', () => {
  it('[EDIT-006][STATE-004] validates resources and sends CSRF, idempotency, and strong artifact ETags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response({ items: [artifact] }))
      .mockResolvedValueOnce(
        response({
          artifacts: [artifact],
          idempotency: { key: 'correct-artifact', replayed: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    expect(await listArtifacts(DAY_ID)).toEqual([artifact]);
    await editArtifact({
      artifactId: ARTIFACT_ID,
      revision: 2,
      csrfToken: 'csrf',
      idempotencyKey: 'correct-artifact',
      edit: { operation: 'correct', overrides: [{ path: '/value', value: 2 }] },
    });
    expect(fetchMock).toHaveBeenLastCalledWith(
      `/api/v1/artifacts/${ARTIFACT_ID}/edits`,
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-csrf-token': 'csrf',
          'idempotency-key': 'correct-artifact',
          'if-match': '"artifact-2"',
        }),
      }),
    );
  });

  it('[FOOD-007] sends every source revision in a merge-set ETag', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        artifacts: [artifact],
        idempotency: { key: 'merge-artifacts', replayed: false },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    await mergeArtifacts({
      csrfToken: 'csrf',
      idempotencyKey: 'merge-artifacts',
      revisions: { [ARTIFACT_ID]: 2, [SECOND_ID]: 4 },
      merge: {
        sourceArtifactIds: [ARTIFACT_ID, SECOND_ID],
        result: {
          artifactId: RESULT_ID,
          logicalKey: 'manual:merge:test',
          payload: { value: 2 },
        },
      },
    });
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/artifacts/merge',
      expect.objectContaining({
        headers: expect.objectContaining({
          'if-match': `"artifacts-${ARTIFACT_ID}:2,${SECOND_ID}:4"`,
        }),
      }),
    );
  });

  it('[EDIT-006] maps stable problem details without reflecting journal payloads', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        response(
          {
            type: 'about:blank',
            title: 'Artifact changed',
            status: 412,
            code: 'artifact_precondition_failed',
            correlationId: RESULT_ID,
          },
          412,
        ),
      ),
    );
    await expect(listArtifacts(DAY_ID)).rejects.toMatchObject<
      Partial<ArtifactApiError>
    >({
      status: 412,
      code: 'artifact_precondition_failed',
      message: 'Artifact changed',
    });
  });

  it('[STATE-003][SEC-003] fails safely when an upstream error is not JSON', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('<h1>proxy failure containing private data</h1>', {
          status: 502,
          headers: { 'content-type': 'text/html' },
        }),
      ),
    );

    await expect(listArtifacts(DAY_ID)).rejects.toMatchObject<
      Partial<ArtifactApiError>
    >({
      status: 502,
      code: 'unknown',
      message: 'The artifact request failed.',
    });
  });
});
