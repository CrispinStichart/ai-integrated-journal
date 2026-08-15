import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  createTemporalContext,
  createUuidV7,
  domainPackageName,
  isUuidV7,
  journalDateAtInstant,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  parseUuidV7,
  startOfJournalDate,
  toTemporalInstant,
  toTemporalPlainDate,
  utcInstantFromEpochMilliseconds,
  uuidV7Timestamp,
} from '../src/index.js';

describe('UUIDv7 identity primitives (ARCH-003, DATA-004, DATA-020)', () => {
  it('creates a canonical branded UUIDv7 with its requested timestamp', () => {
    const id = createUuidV7<'contribution'>({
      timestamp: 1_723_689_000_123,
      randomBytes: (length) => new Uint8Array(length).fill(0xff),
    });

    expect(id).toBe('019153de-dcbb-7fff-bfff-ffffffffffff');
    expect(isUuidV7(id)).toBe(true);
    expect(uuidV7Timestamp(id)).toBe(1_723_689_000_123);
  });

  it('uses secure runtime entropy by default', () => {
    expect(isUuidV7(createUuidV7())).toBe(true);
  });

  it.each([
    '01914EF2-DFBB-7FFF-BFFF-FFFFFFFFFFFF',
    '01914ef2-dfbb-4fff-bfff-ffffffffffff',
    'not-a-uuid',
  ])('rejects a non-canonical or non-v7 identity: %s', (value) => {
    expect(isUuidV7(value)).toBe(false);
    expect(() => parseUuidV7(value)).toThrow(DomainInvariantError);
  });

  it.each([-1, Number.MAX_SAFE_INTEGER, 1.5])(
    'rejects invalid UUID timestamps: %s',
    (timestamp) => {
      expect(() => createUuidV7({ timestamp })).toThrow(
        'non-negative 48-bit integer',
      );
    },
  );

  it('rejects an invalid entropy source', () => {
    expect(() =>
      createUuidV7({ randomBytes: () => new Uint8Array(15) }),
    ).toThrow('exactly 16 bytes');
  });
});

describe('Temporal value objects (TIME-001, TIME-002, TIME-003)', () => {
  it('normalizes offset instants to UTC and preserves exact Temporal meaning', () => {
    const instant = parseUtcInstant('2026-03-08T01:30:00-05:00');

    expect(instant).toBe('2026-03-08T06:30:00Z');
    expect(toTemporalInstant(instant).epochMilliseconds).toBe(
      1_772_951_400_000,
    );
    expect(utcInstantFromEpochMilliseconds(0)).toBe('1970-01-01T00:00:00Z');
  });

  it('derives journal dates and DST-sensitive day boundaries in the named zone', () => {
    const timezone = parseIanaTimezone('America/New_York');
    const instant = parseUtcInstant('2026-03-08T04:30:00Z');
    const date = journalDateAtInstant(instant, timezone);

    expect(timezone).toBe('America/New_York');
    expect(date).toBe('2026-03-07');
    expect(startOfJournalDate(parseJournalDate('2026-03-08'), timezone)).toBe(
      '2026-03-08T05:00:00Z',
    );
    expect(toTemporalPlainDate(date).day).toBe(7);
  });

  it('keeps capture and journal temporal context distinct and immutable', () => {
    const context = createTemporalContext({
      capturedAt: parseUtcInstant('2026-08-15T12:00:00Z'),
      captureTimezone: parseIanaTimezone('Europe/London'),
      journalDate: parseJournalDate('2026-08-14'),
      journalTimezone: parseIanaTimezone('America/Los_Angeles'),
      journalDateAssignment: 'user_override',
    });

    expect(context.journalDate).toBe('2026-08-14');
    expect(context.captureTimezone).not.toBe(context.journalTimezone);
    expect(Object.isFrozen(context)).toBe(true);
    expect(domainPackageName).toBe('@journal/domain');
  });

  it.each(['not-an-instant', '2026-08-15T12:00:00'])(
    'rejects invalid instants: %s',
    (value) => {
      expect(() => parseUtcInstant(value)).toThrow('Invalid ISO 8601 instant');
    },
  );

  it('rejects invalid epoch instants', () => {
    expect(() => utcInstantFromEpochMilliseconds(Number.NaN)).toThrow(
      'valid Temporal instant',
    );
  });

  it.each(['', '+04:00', 'Mars/Olympus_Mons'])(
    'rejects non-IANA timezones: %s',
    (value) => {
      expect(() => parseIanaTimezone(value)).toThrow(
        'Expected an IANA timezone',
      );
    },
  );

  it.each(['2026-02-30', '2026-8-15', 'not-a-date'])(
    'rejects invalid journal dates: %s',
    (value) => {
      expect(() => parseJournalDate(value)).toThrow('YYYY-MM-DD journal date');
    },
  );
});
