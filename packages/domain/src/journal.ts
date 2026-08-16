import { DomainInvariantError } from './errors.js';
import type { UuidV7 } from './identity.js';
import {
  appendRevision,
  type AppendOnlyRevision,
  type RevisionNumber,
} from './revision.js';
import {
  createTemporalContext,
  journalDateAtInstant,
  type IanaTimezone,
  type JournalDate,
  type JournalDateAssignmentSource,
  type TemporalContext,
  type UtcInstant,
} from './temporal.js';

export type JournalDayId = UuidV7<'journal-day'>;
export type ContributionId = UuidV7<'contribution'>;
export type ContributionRevisionId = UuidV7<'contribution-revision'>;
export type NudgeId = UuidV7<'nudge'>;
export type UserId = UuidV7<'user'>;

export type ContributionSourceType =
  'typed_text' | 'recording' | 'nudge_response';

export interface JournalDay {
  readonly id: JournalDayId;
  readonly ownerId: UserId;
  readonly journalDate: JournalDate;
  readonly createdAt: UtcInstant;
}

export interface Contribution {
  readonly id: ContributionId;
  readonly journalDayId: JournalDayId;
  readonly authorId: UserId;
  readonly sourceType: ContributionSourceType;
  readonly temporalContext: TemporalContext;
  readonly elicitingNudgeId?: NudgeId;
  readonly currentRevision?: RevisionNumber;
}

export interface ContributionRevisionValue {
  readonly text: string;
  readonly authority: 'manual' | 'generated';
  readonly authorId: UserId;
  readonly editReason?: string;
}

export type ContributionRevision = AppendOnlyRevision<
  ContributionId,
  ContributionRevisionId,
  ContributionRevisionValue
>;

export function createJournalDay(input: JournalDay): Readonly<JournalDay> {
  return Object.freeze({ ...input });
}

export function assignJournalDate(input: {
  readonly capturedAt: UtcInstant;
  readonly journalTimezone: IanaTimezone;
  readonly override?: JournalDate;
}): Readonly<{
  journalDate: JournalDate;
  assignment: JournalDateAssignmentSource;
}> {
  return Object.freeze(
    input.override === undefined
      ? {
          journalDate: journalDateAtInstant(
            input.capturedAt,
            input.journalTimezone,
          ),
          assignment: 'default' as const,
        }
      : {
          journalDate: input.override,
          assignment: 'user_override' as const,
        },
  );
}

export function createContribution(input: {
  readonly id: ContributionId;
  readonly journalDayId: JournalDayId;
  readonly authorId: UserId;
  readonly sourceType: ContributionSourceType;
  readonly capturedAt: UtcInstant;
  readonly capturedTimezone: IanaTimezone;
  readonly journalTimezone: IanaTimezone;
  readonly journalDate: JournalDate;
  readonly journalDateAssignment: JournalDateAssignmentSource;
  readonly elicitingNudgeId?: NudgeId;
  readonly currentRevision?: RevisionNumber;
}): Readonly<Contribution> {
  if (
    (input.sourceType === 'nudge_response') !==
    (input.elicitingNudgeId !== undefined)
  ) {
    throw new DomainInvariantError(
      'A nudge response must retain exactly one eliciting nudge, and other contribution types must not.',
    );
  }
  if (
    (input.sourceType === 'recording') !==
    (input.currentRevision === undefined)
  ) {
    throw new DomainInvariantError(
      'Text contributions require a current revision; recording content is stored in its immutable recording artifact.',
    );
  }
  if (
    input.journalDateAssignment === 'default' &&
    journalDateAtInstant(input.capturedAt, input.journalTimezone) !==
      input.journalDate
  ) {
    throw new DomainInvariantError(
      'A default journal date must be derived from capture time in the Journal Timezone.',
    );
  }

  return Object.freeze({
    id: input.id,
    journalDayId: input.journalDayId,
    authorId: input.authorId,
    sourceType: input.sourceType,
    temporalContext: createTemporalContext({
      capturedAt: input.capturedAt,
      captureTimezone: input.capturedTimezone,
      journalTimezone: input.journalTimezone,
      journalDate: input.journalDate,
      journalDateAssignment: input.journalDateAssignment,
    }),
    ...(input.elicitingNudgeId === undefined
      ? {}
      : { elicitingNudgeId: input.elicitingNudgeId }),
    ...(input.currentRevision === undefined
      ? {}
      : { currentRevision: input.currentRevision }),
  });
}

export function createContributionRevision(input: {
  readonly contributionId: ContributionId;
  readonly revisionId: ContributionRevisionId;
  readonly currentRevision?: RevisionNumber;
  readonly expectedRevision?: RevisionNumber;
  readonly text: string;
  readonly authority: 'manual' | 'generated';
  readonly authorId: UserId;
  readonly editReason?: string;
  readonly createdAt: UtcInstant;
}): Readonly<ContributionRevision> {
  if (input.text.length === 0) {
    throw new DomainInvariantError('Contribution text must not be empty.');
  }
  if (input.editReason !== undefined && input.editReason.trim().length === 0) {
    throw new DomainInvariantError('An edit reason must not be blank.');
  }

  return appendRevision({
    entityId: input.contributionId,
    revisionId: input.revisionId,
    ...(input.currentRevision === undefined
      ? {}
      : { currentRevision: input.currentRevision }),
    ...(input.expectedRevision === undefined
      ? {}
      : { expectedRevision: input.expectedRevision }),
    value: {
      text: input.text,
      authority: input.authority,
      authorId: input.authorId,
      ...(input.editReason === undefined
        ? {}
        : { editReason: input.editReason }),
    },
    createdAt: input.createdAt,
  });
}
