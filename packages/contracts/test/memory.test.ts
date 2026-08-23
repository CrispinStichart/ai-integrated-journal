import { describe, expect, it } from 'vitest';

import {
  createFeedbackRequestSchema,
  memoryMutationRequestSchema,
  memorySearchRequestSchema,
} from '../src/index.js';

const TARGET_ID = '019c5b90-0000-7000-8000-000000000023';

describe('memory and feedback wire contracts', () => {
  it('[MEM-001][FB-002][FB-003] requires literal approval for correct-and-remember', () => {
    const base = {
      mode: 'correct_and_remember',
      target: { kind: 'transcript_revision', id: TARGET_ID },
      message: 'Remember this.',
      memory: {
        type: 'correction_rule',
        content: 'Preferred spelling is Nicolette.',
        rationale: 'Explicit correction.',
        scope: { kind: 'global_transcription' },
      },
    };
    expect(
      createFeedbackRequestSchema.safeParse({ ...base, approval: 'pending' })
        .success,
    ).toBe(false);
    expect(
      createFeedbackRequestSchema.parse({ ...base, approval: 'approved' }),
    ).toMatchObject({ mode: 'correct_and_remember', approval: 'approved' });
  });

  it('[MEM-004] bounds search, content, and lifecycle mutations', () => {
    expect(
      memorySearchRequestSchema.parse({ q: 'name', limit: '50' }),
    ).toMatchObject({ q: 'name', limit: 50 });
    expect(
      memorySearchRequestSchema.safeParse({ q: 'x'.repeat(101) }).success,
    ).toBe(false);
    expect(memoryMutationRequestSchema.parse({ operation: 'disable' })).toEqual(
      { operation: 'disable' },
    );
  });
});
