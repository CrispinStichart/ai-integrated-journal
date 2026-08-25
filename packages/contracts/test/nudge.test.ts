import { describe, expect, it } from 'vitest';

import {
  nudgeActionRequestSchema,
  nudgeDayResourceSchema,
  nudgePreferenceSchema,
  requirementEvaluationStateSchema,
  updateNudgePreferenceRequestSchema,
} from '../src/index.js';

const id = (suffix: string) =>
  `019c5b90-0000-7000-8000-0000000000${suffix.padStart(2, '0')}`;
const now = '2026-08-23T20:00:00.000Z';

describe('nudge contracts', () => {
  it('[NUDGE-002][DATA-013] preserves exact states, version basis, and linked action identity', () => {
    expect(requirementEvaluationStateSchema.options).toEqual([
      'not_evaluated',
      'satisfied',
      'insufficient_information',
      'pending_user_response',
      'dismissed',
      'not_applicable',
      'failed',
    ]);
    expect(
      nudgeDayResourceSchema.parse({
        journalDate: '2026-08-23',
        evaluations: [
          {
            id: id('1'),
            journalDayId: id('2'),
            journalDate: '2026-08-23',
            processorId: id('3'),
            processorVersionId: id('4'),
            processorName: 'Synthetic requirement',
            state: 'failed',
            revision: 1,
            allowNotApplicable: true,
            prompt: 'Synthetic prompt.',
            supportingRunId: id('5'),
            evaluatedAt: now,
            updatedAt: now,
          },
        ],
      }).evaluations[0]?.state,
    ).toBe('failed');
    expect(
      nudgeActionRequestSchema.parse({
        action: 'answer',
        itemId: id('6'),
        text: 'Synthetic answer.',
        contributionId: id('7'),
        revisionId: id('8'),
        capturedAt: now,
        capturedTimezone: 'Etc/UTC',
      }),
    ).toMatchObject({ action: 'answer', contributionId: id('7') });
    expect(
      nudgeActionRequestSchema.safeParse({
        action: 'dismiss',
        contributionId: id('7'),
        revisionId: id('8'),
        capturedAt: now,
        capturedTimezone: 'Etc/UTC',
        text: 'unsupported',
      }).success,
    ).toBe(false);
  });

  it('[NUDGE-005] validates configurable delivery limits without flattening owner timezone', () => {
    expect(
      nudgePreferenceSchema.parse({
        quietStartHour: 21,
        quietEndHour: 8,
        dailyLimit: 1,
        revision: 1,
        ownerTimezone: 'America/Chicago',
        updatedAt: now,
      }).ownerTimezone,
    ).toBe('America/Chicago');
    expect(
      updateNudgePreferenceRequestSchema.safeParse({
        quietStartHour: 8,
        quietEndHour: 8,
        dailyLimit: 1,
      }).success,
    ).toBe(false);
  });
});
