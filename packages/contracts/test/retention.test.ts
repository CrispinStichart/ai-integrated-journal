import { describe, expect, it } from 'vitest';

import {
  deletionTombstoneSchema,
  permanentDeletionRequestSchema,
} from '../src/index.js';

const ID = '019d2b3c-4000-7000-8000-000000000001';

describe('retention contracts', () => {
  it('[RET-005][SEC-008] requires an explicit destructive confirmation', () => {
    expect(
      permanentDeletionRequestSchema.safeParse({
        entityKind: 'contribution',
        entityId: ID,
        confirmation: 'delete',
      }).success,
    ).toBe(false);
  });

  it('[RET-006] exposes only content-free anti-resurrection tombstone fields', () => {
    const value = deletionTombstoneSchema.parse({
      entityKind: 'contribution',
      entityId: ID,
      deletedAt: '2026-08-25T00:00:00.000Z',
      generation: 4,
    });
    expect(Object.keys(value).sort()).toEqual([
      'deletedAt',
      'entityId',
      'entityKind',
      'generation',
    ]);
    expect(() =>
      deletionTombstoneSchema.parse({ ...value, text: 'private' }),
    ).toThrow();
  });
});
