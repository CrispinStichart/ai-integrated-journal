import { describe, expect, it } from 'vitest';

import {
  DomainInvariantError,
  assignJournalDate,
  createContribution,
  createContributionRevision,
  createJournalDay,
  createUuidV7,
  parseIanaTimezone,
  parseJournalDate,
  parseUtcInstant,
  revisionNumber,
} from '../src/index.js';

const ownerId = createUuidV7<'user'>({ timestamp: 1 });
const journalDayId = createUuidV7<'journal-day'>({ timestamp: 2 });
const contributionId = createUuidV7<'contribution'>({ timestamp: 3 });
const capturedAt = parseUtcInstant('2026-08-16T01:30:00Z');
const capturedTimezone = parseIanaTimezone('Asia/Tokyo');
const journalTimezone = parseIanaTimezone('America/Los_Angeles');

describe('journal days and temporal assignment (DATA-001, DATA-002, DATA-004, TIME-001, TIME-002, TIME-003)', () => {
  it('creates stable days for past and future dates and assigns by journal timezone', () => {
    const assigned = assignJournalDate({ capturedAt, journalTimezone });
    const overridden = assignJournalDate({
      capturedAt,
      journalTimezone,
      override: parseJournalDate('2035-12-24'),
    });

    expect(assigned).toEqual({
      journalDate: '2026-08-15',
      assignment: 'default',
    });
    expect(overridden).toEqual({
      journalDate: '2035-12-24',
      assignment: 'user_override',
    });
    expect(
      createJournalDay({
        id: journalDayId,
        ownerId,
        journalDate: overridden.journalDate,
        createdAt: capturedAt,
      }),
    ).toMatchObject({ id: journalDayId, journalDate: '2035-12-24' });
  });
});

describe('contribution identity and append-only content (DATA-003, DATA-010, DATA-011, DATA-012, DATA-013)', () => {
  it('preserves the complete temporal context and appends a manual revision', () => {
    const contribution = createContribution({
      id: contributionId,
      journalDayId,
      authorId: ownerId,
      sourceType: 'typed_text',
      capturedAt,
      capturedTimezone,
      journalTimezone,
      journalDate: parseJournalDate('2026-08-15'),
      journalDateAssignment: 'default',
      currentRevision: revisionNumber(1),
    });
    const revision = createContributionRevision({
      contributionId,
      revisionId: createUuidV7<'contribution-revision'>({ timestamp: 4 }),
      text: 'Exact synthetic source text.',
      authority: 'manual',
      authorId: ownerId,
      createdAt: capturedAt,
    });

    expect(contribution.temporalContext).toEqual({
      capturedAt: '2026-08-16T01:30:00Z',
      captureTimezone: 'Asia/Tokyo',
      journalTimezone: 'America/Los_Angeles',
      journalDate: '2026-08-15',
      journalDateAssignment: 'default',
    });
    expect(revision.revision).toBe(1);
    expect(revision.value.authority).toBe('manual');
  });

  it('requires durable nudge provenance and meaningful text metadata', () => {
    const common = {
      id: contributionId,
      journalDayId,
      authorId: ownerId,
      capturedAt,
      capturedTimezone,
      journalTimezone,
      journalDate: parseJournalDate('2026-08-15'),
      journalDateAssignment: 'default' as const,
      currentRevision: revisionNumber(1),
    };
    const { currentRevision, ...withoutRevision } = common;

    expect(() =>
      createContribution({ ...common, sourceType: 'nudge_response' }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      createContribution({
        ...common,
        sourceType: 'typed_text',
        journalDate: parseJournalDate('2026-08-16'),
      }),
    ).toThrow('must be derived');
    expect(
      createContribution({
        ...withoutRevision,
        sourceType: 'recording',
      }).currentRevision,
    ).toBeUndefined();
    expect(currentRevision).toBe(1);
    expect(() =>
      createContribution({
        ...withoutRevision,
        sourceType: 'typed_text',
      }),
    ).toThrow('require a current revision');
    expect(() =>
      createContribution({
        ...common,
        sourceType: 'typed_text',
        elicitingNudgeId: createUuidV7<'nudge'>({ timestamp: 5 }),
      }),
    ).toThrow(DomainInvariantError);
    expect(() =>
      createContributionRevision({
        contributionId,
        revisionId: createUuidV7<'contribution-revision'>({ timestamp: 6 }),
        text: '',
        authority: 'manual',
        authorId: ownerId,
        createdAt: capturedAt,
      }),
    ).toThrow('must not be empty');
    expect(() =>
      createContributionRevision({
        contributionId,
        revisionId: createUuidV7<'contribution-revision'>({ timestamp: 7 }),
        text: 'Synthetic source.',
        authority: 'manual',
        authorId: ownerId,
        editReason: '   ',
        createdAt: capturedAt,
      }),
    ).toThrow('must not be blank');
  });
});
