import { Temporal } from '@js-temporal/polyfill';

import { DomainInvariantError } from './errors.js';
import {
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  type IanaTimezone,
  type JournalDate,
  type UtcInstant,
} from './temporal.js';

export const REQUIREMENT_EVALUATION_STATES = [
  'not_evaluated',
  'satisfied',
  'insufficient_information',
  'pending_user_response',
  'dismissed',
  'not_applicable',
  'failed',
] as const;

export type RequirementEvaluationState =
  (typeof REQUIREMENT_EVALUATION_STATES)[number];

export type NudgeAction = 'answer' | 'defer' | 'dismiss' | 'not_applicable';

function record(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * Interprets only explicit processor output structure. Empty item collections
 * and explicit insufficient-information states are missing; explicit none is
 * adequate information and is never collapsed into unknown.
 */
export function hasAdequateRequirementInformation(
  payload: Readonly<Record<string, unknown>>,
): boolean {
  if (payload.informationStatus === 'insufficient_information') return false;
  if (payload.informationStatus === 'explicit_none') return true;
  if (Array.isArray(payload.items)) {
    if (payload.items.length === 0) return false;
    return payload.items.some((item) => {
      const itemRecord = record(item);
      return itemRecord?.informationStatus !== 'insufficient_information';
    });
  }
  return Object.keys(payload).length > 0;
}

export function evaluateRequirementRun(
  input: Readonly<{
    runStatus: 'succeeded' | 'failed' | 'queued' | 'running' | 'canceled';
    completeness?: 'complete' | 'partial';
    payload?: Readonly<Record<string, unknown>>;
  }>,
): RequirementEvaluationState {
  if (input.runStatus === 'failed') return 'failed';
  if (input.runStatus !== 'succeeded' || input.completeness !== 'complete')
    return 'not_evaluated';
  if (input.payload === undefined)
    throw new DomainInvariantError(
      'A successful complete requirement run must provide a payload.',
    );
  return hasAdequateRequirementInformation(input.payload)
    ? 'satisfied'
    : 'insufficient_information';
}

export interface NudgeQuietHours {
  readonly startHour: number;
  readonly endHour: number;
}

export const DEFAULT_NUDGE_QUIET_HOURS: NudgeQuietHours = Object.freeze({
  startHour: 21,
  endHour: 8,
});

function assertHour(hour: number): void {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23)
    throw new DomainInvariantError(
      'Quiet-hour boundaries must be 0 through 23.',
    );
}

export function nudgeLocalDate(
  instant: UtcInstant,
  timezone: IanaTimezone,
): JournalDate {
  return parseJournalDate(
    Temporal.Instant.from(instant)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString(),
  );
}

/** Returns now outside quiet hours, otherwise the next local quiet-hours end. */
export function nextNudgeDeliveryInstant(
  instant: UtcInstant,
  timezone: IanaTimezone,
  quietHours: NudgeQuietHours = DEFAULT_NUDGE_QUIET_HOURS,
): UtcInstant {
  assertHour(quietHours.startHour);
  assertHour(quietHours.endHour);
  if (quietHours.startHour === quietHours.endHour)
    throw new DomainInvariantError('Quiet hours must leave a delivery window.');
  const zoned = Temporal.Instant.from(instant).toZonedDateTimeISO(timezone);
  const hour = zoned.hour;
  const wraps = quietHours.startHour > quietHours.endHour;
  const quiet = wraps
    ? hour >= quietHours.startHour || hour < quietHours.endHour
    : hour >= quietHours.startHour && hour < quietHours.endHour;
  if (!quiet) return parseUtcInstant(instant);
  const deliveryDate =
    wraps && hour >= quietHours.startHour
      ? zoned.toPlainDate().add({ days: 1 })
      : zoned.toPlainDate();
  return parseUtcInstant(
    deliveryDate
      .toPlainDateTime({ hour: quietHours.endHour })
      .toZonedDateTime(timezone)
      .toInstant()
      .toString(),
  );
}

export function validateNudgePolicy(
  input: Readonly<{
    timezone: string;
    quietStartHour: number;
    quietEndHour: number;
    dailyLimit: number;
  }>,
): Readonly<{
  timezone: IanaTimezone;
  quietStartHour: number;
  quietEndHour: number;
  dailyLimit: number;
}> {
  const timezone = parseIanaTimezone(input.timezone);
  assertHour(input.quietStartHour);
  assertHour(input.quietEndHour);
  if (input.quietStartHour === input.quietEndHour)
    throw new DomainInvariantError('Quiet hours must leave a delivery window.');
  if (
    !Number.isSafeInteger(input.dailyLimit) ||
    input.dailyLimit < 0 ||
    input.dailyLimit > 24
  )
    throw new DomainInvariantError(
      'Daily nudge limit must be between 0 and 24.',
    );
  return Object.freeze({ ...input, timezone });
}
