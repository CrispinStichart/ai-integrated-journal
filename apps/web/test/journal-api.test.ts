// @vitest-environment jsdom

import {
  contributionSchema,
  journalDaySummaryPageSchema,
  uuidV7Schema,
} from '@journal/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createContribution,
  createUuidV7,
  editContribution,
  getContribution,
  getJournalDay,
  JournalApiError,
  listContributionRevisions,
  listJournalDays,
  setContributionDeleted,
} from '../src/journal/api';

const IDS = {
  author: '018f0000-0000-7000-8000-000000000001',
  day: '018f0000-0000-7000-8000-000000000002',
  contribution: '018f0000-0000-7000-8000-000000000003',
  revision: '018f0000-0000-7000-8000-000000000004',
} as const;

const revision = {
  id: IDS.revision,
  contributionId: IDS.contribution,
  revision: 1,
  text: 'A durable note',
  authority: 'manual' as const,
  authorId: IDS.author,
  createdAt: '2026-08-16T12:00:00.000Z',
};
const contribution = contributionSchema.parse({
  id: IDS.contribution,
  journalDayId: IDS.day,
  journalDate: '2026-08-16',
  authorId: IDS.author,
  sourceType: 'typed_text',
  capturedAt: '2026-08-16T12:00:00.000Z',
  capturedTimezone: 'UTC',
  journalTimezone: 'UTC',
  journalDateAssignment: 'default',
  currentRevision: revision,
});

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function mutationResponse(value = contribution) {
  return {
    contribution: value,
    idempotency: { key: 'mutation-key', replayed: false },
  };
}

describe('Journal REST browser client (DATA-001–DATA-013, DATA-026, TIME-001–TIME-003, STATE-006–STATE-007)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads calendar pages, empty and complete days, contributions, and all history pages', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        json(
          journalDaySummaryPageSchema.parse({
            items: [
              {
                id: IDS.day,
                journalDate: '2026-08-16',
                contributionCount: 1,
                latestContributionAt: '2026-08-16T12:00:00.000Z',
              },
            ],
            page: { hasMore: true, nextCursor: 'next_page' },
          }),
        ),
      )
      .mockResolvedValueOnce(json({ title: 'Not found' }, 404))
      .mockResolvedValueOnce(
        json({
          id: IDS.day,
          journalDate: '2026-08-16',
          createdAt: '2026-08-16T10:00:00.000Z',
          contributions: [contribution],
        }),
      )
      .mockResolvedValueOnce(json(contribution))
      .mockResolvedValueOnce(
        json({ items: [revision], page: { hasMore: true, nextCursor: 'two' } }),
      )
      .mockResolvedValueOnce(
        json({
          items: [{ ...revision, revision: 2 }],
          page: { hasMore: false },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(listJournalDays()).resolves.toMatchObject({
      items: [{ contributionCount: 1 }],
      nextCursor: 'next_page',
    });
    await expect(getJournalDay('2026-08-15')).resolves.toBeUndefined();
    await expect(getJournalDay('2026-08-16')).resolves.toMatchObject({
      contributions: [{ id: IDS.contribution }],
    });
    await expect(getContribution(IDS.contribution)).resolves.toEqual(
      contribution,
    );
    await expect(
      listContributionRevisions(IDS.contribution),
    ).resolves.toHaveLength(2);
    expect(fetchMock.mock.calls[0]?.[0]).toContain('limit=100');
    expect(fetchMock.mock.calls[1]?.[0]).toContain('includeDeleted=true');
  });

  it('creates, edits, deletes, and restores with CSRF, idempotency, UUIDv7 identities, and ETags', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(json(mutationResponse(), 201))
      .mockResolvedValueOnce(json(mutationResponse()))
      .mockResolvedValueOnce(json(mutationResponse()))
      .mockResolvedValueOnce(json(mutationResponse()));
    vi.stubGlobal('fetch', fetchMock);

    await createContribution(
      {
        contributionId: IDS.contribution,
        revisionId: IDS.revision,
        proposedJournalDayId: IDS.day,
        sourceType: 'typed_text',
        text: 'A durable note',
        capturedAt: '2026-08-16T12:00:00.000Z',
        capturedTimezone: 'UTC',
        journalTimezone: 'UTC',
        journalDate: '2026-08-16',
        journalDateAssignment: 'default',
      },
      'csrf',
      'mutation-key',
    );
    await editContribution(
      contribution,
      'Edited note',
      'Fixed it',
      IDS.revision,
      'csrf',
      'mutation-key',
    );
    await setContributionDeleted(contribution, true, 'csrf', 'mutation-key');
    await setContributionDeleted(contribution, false, 'csrf', 'mutation-key');

    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ method: 'POST' });
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toMatchObject({
      'if-match': '"revision-1"',
      'x-csrf-token': 'csrf',
    });
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({ method: 'DELETE' });
    expect(fetchMock.mock.calls[3]?.[0]).toContain('/restore');
    expect(uuidV7Schema.safeParse(createUuidV7()).success).toBe(true);
  });

  it('exposes stable problem codes for edit conflict handling', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json(
          {
            type: 'about:blank',
            title: 'Contribution changed',
            status: 412,
            code: 'etag_mismatch',
            correlationId: '018f0000-0000-7000-8000-000000000099',
          },
          412,
        ),
      ),
    );

    await expect(getContribution(IDS.contribution)).rejects.toMatchObject<
      Partial<JournalApiError>
    >({ status: 412, code: 'etag_mismatch' });
  });
});
