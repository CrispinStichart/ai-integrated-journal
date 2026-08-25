import {
  GroundedAnswerRepository,
  type GroundedAnswerRecord,
  type JournalDatabase,
} from '@journal/database';
import type { PgBoss } from 'pg-boss';
import { describe, expect, it, vi } from 'vitest';

import { PostgresGroundedAnswerService } from '../src/grounded-answer-service.js';
import type { SearchService } from '../src/search-service.js';

const ANSWER_ID = '019c5b90-0000-7000-8000-000000000951';
const OWNER_ID = '019c5b90-0000-7000-8000-000000000952';
const FRAGMENT_ID = '019c5b90-0000-7000-8000-000000000953';
const REVISION_ID = '019c5b90-0000-7000-8000-000000000954';
const SOURCE_ID = '019c5b90-0000-7000-8000-000000000955';

function persisted(
  overrides: Partial<GroundedAnswerRecord> = {},
): GroundedAnswerRecord {
  return {
    id: ANSWER_ID,
    ownerId: OWNER_ID,
    question: 'What happened?',
    request: { question: 'What happened?' },
    requestHash: 'a'.repeat(64),
    retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
    status: 'succeeded',
    jobId: '019c5b90-0000-7000-8000-000000000956',
    synthesis: 'You took a walk.',
    failureCode: null,
    promptId: 'grounded-answer',
    promptVersion: '1.0.0',
    promptTemplateHash: 'b'.repeat(64),
    requestedConfiguration: { temperature: 0 },
    effectiveMessagesHash: 'c'.repeat(64),
    provider: { id: 'fake' },
    model: { id: 'fake-v1' },
    effectiveConfiguration: { parameters: {}, fingerprint: 'd'.repeat(64) },
    usage: { status: 'unknown' },
    processingTimeMilliseconds: 5n,
    rawResponseId: '019c5b90-0000-7000-8000-000000000957',
    rawResponseMediaType: 'application/json',
    rawResponseByteSize: 20n,
    rawResponseSha256: 'e'.repeat(64),
    rawResponseRetention: 'days_30',
    rawResponseExpiresAt: new Date('2026-09-24T04:00:00.000Z'),
    requestedAt: new Date('2026-08-25T04:00:00.000Z'),
    completedAt: new Date('2026-08-25T04:00:01.000Z'),
    citations: [
      {
        citationId: `cite_${'f'.repeat(32)}`,
        suppliedOrdinal: 0,
        citedOrdinal: 0,
        fragmentId: FRAGMENT_ID,
        sourceKind: 'contribution_revision',
        layer: 'typed_text',
        sourceId: SOURCE_ID,
        sourceRevisionId: REVISION_ID,
        sourceRevision: 1,
        journalDate: '2026-08-25',
        authority: 'manual',
        retrievedQuote: 'I took a walk.',
        normalization: 'NFC_LF_V1',
        offsetUnit: 'utf16_code_unit',
        startUtf16: 0,
        endUtf16: 14,
        quoteSha256: 'f'.repeat(64),
        href: `/journal/2026-08-25?revision=${REVISION_ID}`,
      },
    ],
    allCitationsCurrent: true,
    ...overrides,
  };
}

describe('grounded answer API service', () => {
  it('[SEARCH-003][SEARCH-005][SEARCH-007] snapshots only bounded retrieved fragment IDs and exposes complete lineage', async () => {
    const search: SearchService = {
      search: vi.fn(async () => ({
        items: [
          {
            fragmentId: FRAGMENT_ID,
            sourceKind: 'contribution_revision' as const,
            layer: 'typed_text' as const,
            sourceId: SOURCE_ID,
            sourceRevisionId: REVISION_ID,
            sourceRevision: 1,
            journalDate: '2026-08-25',
            authority: 'manual' as const,
            score: 1,
            snippet: [{ text: 'walk', highlighted: true }],
            href: `/journal/2026-08-25?revision=${REVISION_ID}`,
          },
        ],
        retrieval: {
          requestedMode: 'hybrid' as const,
          effectiveMode: 'lexical' as const,
        },
      })),
    };
    const repository = {
      create: vi.fn(async () => ({ answerId: ANSWER_ID, created: true })),
      loadForOwner: vi.fn(async () => persisted()),
    } as unknown as GroundedAnswerRepository;
    const service = new PostgresGroundedAnswerService(
      {} as JournalDatabase,
      {} as PgBoss,
      search,
      repository,
    );
    const answer = await service.ask(
      OWNER_ID,
      {
        question: 'What happened?',
        mode: 'hybrid',
        layers: ['typed_text'],
        authority: 'manual',
      },
      'grounded-fixture-1',
    );
    expect(search.search).toHaveBeenCalledWith(
      OWNER_ID,
      expect.objectContaining({
        q: 'What happened?',
        limit: 8,
        layers: ['typed_text'],
        authority: 'manual',
      }),
    );
    expect(repository.create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        fragmentIds: [FRAGMENT_ID],
        requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      }),
    );
    expect(answer).toMatchObject({
      status: 'succeeded',
      synthesis: 'You took a walk.',
      citations: [{ sourceRevisionId: REVISION_ID }],
      lineage: {
        provider: { id: 'fake' },
        model: { id: 'fake-v1' },
        rawResponse: { retention: 'days_30' },
      },
    });
  });

  it('[SEARCH-006][SEARCH-007] suppresses stored synthesis immediately when exact cited fragments are no longer current', async () => {
    const repository = {
      loadForOwner: vi.fn(async () =>
        persisted({ allCitationsCurrent: false }),
      ),
    } as unknown as GroundedAnswerRepository;
    const service = new PostgresGroundedAnswerService(
      {} as JournalDatabase,
      {} as PgBoss,
      { search: vi.fn() },
      repository,
    );
    await expect(service.get(OWNER_ID, ANSWER_ID)).resolves.toEqual(
      expect.objectContaining({
        status: 'insufficient_support',
        citations: [],
      }),
    );
    const answer = await service.get(OWNER_ID, ANSWER_ID);
    expect(answer.synthesis).toBeUndefined();
    expect(answer.lineage).toBeUndefined();
  });
});
