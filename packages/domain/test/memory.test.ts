import { describe, expect, it } from 'vitest';

import { classifyFeedbackScope, isTranscriptionMemory } from '../src/index.js';

describe('MEM/FB narrow-safe feedback classification', () => {
  it('[MEM-001][MEM-002][FB-004][AC-030] defaults ambiguous feedback to occurrence-only', () => {
    expect(classifyFeedbackScope({})).toEqual({ kind: 'occurrence_only' });
    expect(
      classifyFeedbackScope({
        requestedScope: { kind: 'global_transcription' },
      }),
    ).toEqual({ kind: 'occurrence_only' });
  });

  it('[FB-002][FB-004] rejects a broad scope that does not match the memory type', () => {
    expect(() =>
      classifyFeedbackScope({
        memoryType: 'correction_rule',
        requestedScope: { kind: 'global_application_preference' },
      }),
    ).toThrow('global transcription scope');
    expect(() =>
      classifyFeedbackScope({
        memoryType: 'processor_rule',
        requestedScope: { kind: 'global_known_fact' },
      }),
    ).toThrow('exact processor scope');
  });

  it('[STT-003][MEM-005] identifies only supported transcription context types', () => {
    expect(isTranscriptionMemory('known_entity')).toBe(true);
    expect(isTranscriptionMemory('processor_rule')).toBe(false);
  });
});
