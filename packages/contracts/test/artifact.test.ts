import { describe, expect, it } from 'vitest';

import {
  artifactEditRequestSchema,
  artifactMergeRequestSchema,
  artifactResourceSchema,
} from '../src/index.js';

const ID = '01890f2e-7c10-7abc-8def-0123456789ab';
const OTHER = '01890f2e-7c11-7abc-8def-0123456789ab';

describe('manual artifact contracts', () => {
  it('[EDIT-006][FOOD-007] distinguishes bounded correction, confirmation, deletion, split, and review commands', () => {
    for (const value of [
      { operation: 'correct', overrides: [{ path: '/amount', value: 2 }] },
      { operation: 'confirm' },
      { operation: 'delete' },
      { operation: 'adopt_candidate', candidateId: ID },
      { operation: 'dismiss_candidate', candidateId: ID },
      { operation: 'release_override' },
      {
        operation: 'split',
        results: [
          {
            artifactId: ID,
            logicalKey: 'manual:split:a',
            payload: { value: 1 },
          },
          {
            artifactId: OTHER,
            logicalKey: 'manual:split:b',
            payload: { value: 2 },
          },
        ],
      },
    ])
      expect(artifactEditRequestSchema.safeParse(value).success).toBe(true);
    expect(
      artifactEditRequestSchema.safeParse({
        operation: 'correct',
        overrides: [{ path: '/__proto__/x', value: true }],
      }).success,
    ).toBe(false);
    expect(
      artifactEditRequestSchema.safeParse({
        operation: 'split',
        results: [{ artifactId: ID, logicalKey: 'generated', payload: {} }],
      }).success,
    ).toBe(false);
  });

  it('[FOOD-007][EDIT-006] requires merge outputs to use reserved manual logical identity', () => {
    expect(
      artifactMergeRequestSchema.safeParse({
        sourceArtifactIds: [ID, OTHER],
        result: {
          artifactId: ID,
          logicalKey: 'manual:merge:a',
          payload: { value: 1 },
        },
      }).success,
    ).toBe(true);
    expect(
      artifactMergeRequestSchema.safeParse({
        sourceArtifactIds: [ID],
        result: { artifactId: ID, logicalKey: 'manual:merge:a', payload: {} },
      }).success,
    ).toBe(false);
  });

  it('[ARCH-004][PROV-004] keeps manual authority, candidate status, override paths, and history explicit', () => {
    const parsed = artifactResourceSchema.parse({
      id: ID,
      processorId: OTHER,
      journalDayId: ID,
      logicalKey: 'string:item',
      kind: 'observation',
      revision: 2,
      active: true,
      deleted: false,
      authority: 'manual',
      payload: { value: 2 },
      manualOperation: 'correct',
      overridePaths: ['/value'],
      candidates: [],
      evidence: [],
      history: [],
      createdAt: '2026-08-23T18:00:00.000Z',
      updatedAt: '2026-08-23T18:00:00.000Z',
    });
    expect(parsed).toMatchObject({
      authority: 'manual',
      overridePaths: ['/value'],
    });
  });
});
