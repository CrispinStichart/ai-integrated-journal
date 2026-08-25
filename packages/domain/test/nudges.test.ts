import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  evaluateRequirementRun,
  hasAdequateRequirementInformation,
  nextNudgeDeliveryInstant,
  nudgeLocalDate,
  parseIanaTimezone,
  parseUtcInstant,
  validateNudgePolicy,
} from '../src/index.js';

describe('requirement evaluation and nudge policy', () => {
  it('[NUDGE-002][NUDGE-004][NUDGE-007][AC-043] preserves all processing outcomes without calling a failure missing information', () => {
    expect(evaluateRequirementRun({ runStatus: 'queued' })).toBe(
      'not_evaluated',
    );
    expect(
      evaluateRequirementRun({
        runStatus: 'succeeded',
        completeness: 'partial',
      }),
    ).toBe('not_evaluated');
    expect(evaluateRequirementRun({ runStatus: 'failed' })).toBe('failed');
    expect(
      evaluateRequirementRun({
        runStatus: 'succeeded',
        completeness: 'complete',
        payload: { items: [] },
      }),
    ).toBe('insufficient_information');
    expect(
      evaluateRequirementRun({
        runStatus: 'succeeded',
        completeness: 'complete',
        payload: { items: [{ value: 'synthetic' }] },
      }),
    ).toBe('satisfied');
    expect(() =>
      evaluateRequirementRun({
        runStatus: 'succeeded',
        completeness: 'complete',
      }),
    ).toThrow(DomainInvariantError);
  });

  it('[SEM-001][SEM-003][NUDGE-002] distinguishes unknown, explicit none, and adequate information', () => {
    expect(
      hasAdequateRequirementInformation({
        informationStatus: 'insufficient_information',
        items: [{ value: 0 }],
      }),
    ).toBe(false);
    expect(
      hasAdequateRequirementInformation({
        informationStatus: 'explicit_none',
        items: [],
      }),
    ).toBe(true);
    expect(
      hasAdequateRequirementInformation({
        items: [{ informationStatus: 'insufficient_information' }],
      }),
    ).toBe(false);
    expect(hasAdequateRequirementInformation({ status: 'known' })).toBe(true);
    expect(hasAdequateRequirementInformation({})).toBe(false);
  });

  it('[NUDGE-005][TIME-001] defers delivery through owner-local default quiet hours including DST', () => {
    const zone = parseIanaTimezone('America/New_York');
    expect(
      nextNudgeDeliveryInstant(parseUtcInstant('2026-03-08T06:30:00Z'), zone),
    ).toBe('2026-03-08T12:00:00Z');
    expect(
      nextNudgeDeliveryInstant(parseUtcInstant('2026-03-09T02:30:00Z'), zone),
    ).toBe('2026-03-09T12:00:00Z');
    expect(
      nextNudgeDeliveryInstant(parseUtcInstant('2026-03-08T17:00:00Z'), zone),
    ).toBe('2026-03-08T17:00:00Z');
    expect(nudgeLocalDate(parseUtcInstant('2026-03-08T04:30:00Z'), zone)).toBe(
      '2026-03-07',
    );
  });

  it('[NUDGE-005] supports configurable non-wrapping hours and rejects unsafe limits', () => {
    const zone = parseIanaTimezone('Etc/UTC');
    expect(
      nextNudgeDeliveryInstant(parseUtcInstant('2026-08-23T12:00:00Z'), zone, {
        startHour: 10,
        endHour: 14,
      }),
    ).toBe('2026-08-23T14:00:00Z');
    expect(
      validateNudgePolicy({
        timezone: zone,
        quietStartHour: 22,
        quietEndHour: 7,
        dailyLimit: 0,
      }),
    ).toMatchObject({ dailyLimit: 0, timezone: 'Etc/UTC' });
    expect(() =>
      validateNudgePolicy({
        timezone: zone,
        quietStartHour: 8,
        quietEndHour: 8,
        dailyLimit: 1,
      }),
    ).toThrow('delivery window');
    expect(() =>
      validateNudgePolicy({
        timezone: zone,
        quietStartHour: -1,
        quietEndHour: 8,
        dailyLimit: 1,
      }),
    ).toThrow('0 through 23');
    expect(() =>
      validateNudgePolicy({
        timezone: zone,
        quietStartHour: 21,
        quietEndHour: 8,
        dailyLimit: 25,
      }),
    ).toThrow('between 0 and 24');
  });
});
