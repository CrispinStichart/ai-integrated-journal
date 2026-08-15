import { Temporal } from '@js-temporal/polyfill';

import { DomainInvariantError } from './errors.js';

declare const utcInstantBrand: unique symbol;
declare const ianaTimezoneBrand: unique symbol;
declare const journalDateBrand: unique symbol;

export type UtcInstant = string & { readonly [utcInstantBrand]: true };
export type IanaTimezone = string & { readonly [ianaTimezoneBrand]: true };
export type JournalDate = string & { readonly [journalDateBrand]: true };

const OFFSET_TIMEZONE = /^[+-]\d{2}(?::?\d{2})?$/;

export function parseUtcInstant(value: string): UtcInstant {
  let instant: Temporal.Instant;
  try {
    instant = Temporal.Instant.from(value);
  } catch {
    throw new DomainInvariantError(`Invalid ISO 8601 instant: "${value}".`);
  }

  return instant.toString() as UtcInstant;
}

export function utcInstantFromEpochMilliseconds(
  epochMilliseconds: number,
): UtcInstant {
  try {
    return Temporal.Instant.fromEpochMilliseconds(
      epochMilliseconds,
    ).toString() as UtcInstant;
  } catch {
    throw new DomainInvariantError(
      'Epoch milliseconds must describe a valid Temporal instant.',
    );
  }
}

export function toTemporalInstant(value: UtcInstant): Temporal.Instant {
  return Temporal.Instant.from(value);
}

export function parseIanaTimezone(value: string): IanaTimezone {
  if (value.length === 0 || OFFSET_TIMEZONE.test(value)) {
    throw new DomainInvariantError(
      `Expected an IANA timezone, received "${value}".`,
    );
  }

  try {
    const zoned = Temporal.ZonedDateTime.from({
      timeZone: value,
      year: 2000,
      month: 1,
      day: 1,
    });
    return zoned.timeZoneId as IanaTimezone;
  } catch {
    throw new DomainInvariantError(
      `Expected an IANA timezone, received "${value}".`,
    );
  }
}

export function parseJournalDate(value: string): JournalDate {
  try {
    const date = Temporal.PlainDate.from(value);
    if (date.toString() !== value) {
      throw new RangeError('Non-canonical date');
    }
    return value as JournalDate;
  } catch {
    throw new DomainInvariantError(
      `Expected a YYYY-MM-DD journal date, received "${value}".`,
    );
  }
}

export function toTemporalPlainDate(value: JournalDate): Temporal.PlainDate {
  return Temporal.PlainDate.from(value);
}

export function journalDateAtInstant(
  instant: UtcInstant,
  timezone: IanaTimezone,
): JournalDate {
  return parseJournalDate(
    toTemporalInstant(instant)
      .toZonedDateTimeISO(timezone)
      .toPlainDate()
      .toString(),
  );
}

export function startOfJournalDate(
  date: JournalDate,
  timezone: IanaTimezone,
): UtcInstant {
  return parseUtcInstant(
    toTemporalPlainDate(date).toZonedDateTime(timezone).toInstant().toString(),
  );
}

export type JournalDateAssignmentSource =
  'default' | 'user_override' | 'migration';

/** Immutable context used when resolving relative temporal language. */
export interface TemporalContext {
  readonly capturedAt: UtcInstant;
  readonly captureTimezone: IanaTimezone;
  readonly journalDate: JournalDate;
  readonly journalTimezone: IanaTimezone;
  readonly journalDateAssignment: JournalDateAssignmentSource;
}

export function createTemporalContext(
  input: TemporalContext,
): Readonly<TemporalContext> {
  return Object.freeze({ ...input });
}
