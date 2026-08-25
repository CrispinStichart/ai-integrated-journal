import { describe, expect, it } from 'vitest';

import {
  groundedAnswerRequestSchema,
  groundedAnswerSchema,
  lexicalSearchPageSchema,
  lexicalSearchRequestSchema,
} from '../src/index.js';

describe('lexical search contracts', () => {
  it('[SEARCH-001][SEARCH-005] parses composable layer and lifecycle filters', () => {
    expect(
      lexicalSearchRequestSchema.parse({
        q: ' morning walk ',
        mode: 'hybrid',
        layers: 'typed_text,corrected,observation',
        contributionTypes: 'typed_text,recording',
        dateFrom: '2026-08-01',
        dateTo: '2026-08-25',
        authority: 'manual',
      }),
    ).toMatchObject({
      q: 'morning walk',
      mode: 'hybrid',
      layers: ['typed_text', 'corrected', 'observation'],
      contributionTypes: ['typed_text', 'recording'],
      limit: 20,
    });
    expect(
      lexicalSearchRequestSchema.safeParse({
        q: 'walk',
        dateFrom: '2026-08-25',
        dateTo: '2026-08-01',
      }).success,
    ).toBe(false);
  });

  it('[SEARCH-003][SEARCH-004] carries precise revision links and text-only snippet segments', () => {
    expect(
      lexicalSearchPageSchema.parse({
        items: [
          {
            fragmentId: '019c5b90-0000-7000-8000-000000000041',
            sourceKind: 'contribution_revision',
            layer: 'typed_text',
            sourceId: '019c5b90-0000-7000-8000-000000000042',
            sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
            sourceRevision: 2,
            journalDate: '2026-08-25',
            contributionId: '019c5b90-0000-7000-8000-000000000042',
            contributionType: 'typed_text',
            authority: 'manual',
            score: 0.5,
            snippet: [
              { text: '<img src=x onerror=alert(1)>', highlighted: true },
            ],
            href: '/journal/2026-08-25?revision=exact',
          },
        ],
        retrieval: {
          requestedMode: 'hybrid',
          effectiveMode: 'hybrid',
          cohort: {
            providerId: 'fixture',
            modelId: 'semantic-v1',
            dimension: 4,
            configurationFingerprint: 'a'.repeat(64),
          },
        },
        page: { hasMore: false },
      }).items[0]?.snippet[0]?.text,
    ).toBe('<img src=x onerror=alert(1)>');
  });

  it('[SEARCH-003][SEARCH-004][SEARCH-007] keeps synthesis and retrieved citations distinct and models explicit insufficiency', () => {
    expect(
      groundedAnswerRequestSchema.parse({
        question: ' What did I do? ',
        mode: 'hybrid',
        layers: ['typed_text', 'summary'],
      }),
    ).toMatchObject({ question: 'What did I do?', mode: 'hybrid' });
    expect(
      groundedAnswerSchema.parse({
        id: '019c5b90-0000-7000-8000-000000000043',
        question: 'What did I do?',
        status: 'succeeded',
        retrieval: { requestedMode: 'hybrid', effectiveMode: 'lexical' },
        synthesis: 'You took a walk.',
        citations: [
          {
            citationId: `cite_${'a'.repeat(32)}`,
            sourceKind: 'contribution_revision',
            layer: 'typed_text',
            sourceId: '019c5b90-0000-7000-8000-000000000042',
            sourceRevisionId: '019c5b90-0000-7000-8000-000000000041',
            sourceRevision: 2,
            journalDate: '2026-08-25',
            authority: 'manual',
            retrievedQuote: '<script>quoted only</script>',
            evidence: {
              normalization: 'NFC_LF_V1',
              offsetUnit: 'utf16_code_unit',
              startUtf16: 0,
              endUtf16: 28,
              quoteSha256: 'b'.repeat(64),
            },
            href: '/journal/2026-08-25?revision=exact',
          },
        ],
        requestedAt: '2026-08-25T04:00:00.000Z',
        completedAt: '2026-08-25T04:00:01.000Z',
      }).citations[0]?.retrievedQuote,
    ).toBe('<script>quoted only</script>');
    expect(
      groundedAnswerSchema.safeParse({
        id: '019c5b90-0000-7000-8000-000000000043',
        question: 'Unsupported?',
        status: 'insufficient_support',
        retrieval: { requestedMode: 'lexical', effectiveMode: 'lexical' },
        citations: [],
        requestedAt: '2026-08-25T04:00:00.000Z',
      }).success,
    ).toBe(true);
  });
});
