import { z } from 'zod';

import { createCursorPageSchema } from './pagination.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';
import { recordingTranscriptionSchema } from './transcription.js';

export const journalDateSchema = z.iso
  .date()
  .describe('Canonical YYYY-MM-DD journal date.');
export const ianaTimezoneSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return !/^[+-]/.test(value);
    } catch {
      return false;
    }
  }, 'Expected an IANA timezone name.');
export const contributionSourceTypeSchema = z.enum([
  'typed_text',
  'recording',
  'nudge_response',
]);
export const journalDateAssignmentSchema = z.enum([
  'default',
  'user_override',
  'migration',
]);
export const revisionNumberSchema = z.number().int().positive();

export const contributionRevisionSchema = z.strictObject({
  id: uuidV7Schema,
  contributionId: uuidV7Schema,
  revision: revisionNumberSchema,
  text: z.string().min(1),
  authority: z.enum(['manual', 'generated']),
  authorId: uuidV7Schema,
  editReason: z.string().min(1).optional(),
  createdAt: utcInstantSchema,
});

export const contributionRecordingSchema = z.strictObject({
  id: uuidV7Schema,
  mimeType: z.string().min(1).max(255),
  codec: z.string().min(1).optional(),
  persistenceState: z.enum(['uploading', 'prepared', 'durable']),
  transcription: recordingTranscriptionSchema.optional(),
  durationMilliseconds: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .optional(),
  byteSize: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .optional(),
  audioDeletedAt: utcInstantSchema.optional(),
});

export const contributionSchema = z.strictObject({
  id: uuidV7Schema,
  journalDayId: uuidV7Schema,
  journalDate: journalDateSchema,
  authorId: uuidV7Schema,
  sourceType: contributionSourceTypeSchema,
  capturedAt: utcInstantSchema,
  capturedTimezone: ianaTimezoneSchema,
  journalTimezone: ianaTimezoneSchema,
  journalDateAssignment: journalDateAssignmentSchema,
  recording: contributionRecordingSchema.optional(),
  elicitingNudgeId: uuidV7Schema.optional(),
  currentRevision: contributionRevisionSchema.optional(),
  deletedAt: utcInstantSchema.optional(),
  restoredAt: utcInstantSchema.optional(),
});

export const journalDaySummarySchema = z.strictObject({
  id: uuidV7Schema,
  journalDate: journalDateSchema,
  contributionCount: z.number().int().nonnegative(),
  latestContributionAt: utcInstantSchema.optional(),
});
export const journalDaySummaryPageSchema = createCursorPageSchema(
  journalDaySummarySchema,
);
export const journalDayViewSchema = z.strictObject({
  id: uuidV7Schema,
  journalDate: journalDateSchema,
  createdAt: utcInstantSchema,
  contributions: z.array(contributionSchema),
});
export const contributionRevisionPageSchema = createCursorPageSchema(
  contributionRevisionSchema,
);

const contributionIdentitySchema = z.strictObject({
  contributionId: uuidV7Schema,
  revisionId: uuidV7Schema,
  proposedJournalDayId: uuidV7Schema,
});
export const createContributionRequestSchema = contributionIdentitySchema
  .extend({
    sourceType: z.enum(['typed_text', 'nudge_response']),
    text: z.string().min(1),
    capturedAt: utcInstantSchema,
    capturedTimezone: ianaTimezoneSchema,
    journalTimezone: ianaTimezoneSchema,
    journalDate: journalDateSchema,
    journalDateAssignment: journalDateAssignmentSchema,
    elicitingNudgeId: uuidV7Schema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.sourceType === 'nudge_response') !==
      (value.elicitingNudgeId !== undefined)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['elicitingNudgeId'],
        message:
          'Nudge responses require an eliciting nudge, and typed text must not provide one.',
      });
    }
  });
export const editContributionRequestSchema = z.strictObject({
  revisionId: uuidV7Schema,
  text: z.string().min(1),
  editReason: z.string().trim().min(1).optional(),
});
export const moveContributionRequestSchema = z.strictObject({
  proposedJournalDayId: uuidV7Schema,
  journalDate: journalDateSchema,
});
export const contributionMutationResponseSchema = z.strictObject({
  contribution: contributionSchema,
  idempotency: z.strictObject({
    key: z.string().min(8).max(255),
    replayed: z.boolean(),
  }),
});

export type ContributionResource = z.infer<typeof contributionSchema>;
export type ContributionRecordingResource = z.infer<
  typeof contributionRecordingSchema
>;
export type ContributionRevisionResource = z.infer<
  typeof contributionRevisionSchema
>;
export type JournalDaySummary = z.infer<typeof journalDaySummarySchema>;
export type JournalDayView = z.infer<typeof journalDayViewSchema>;
export type CreateContributionRequest = z.infer<
  typeof createContributionRequestSchema
>;
export type EditContributionRequest = z.infer<
  typeof editContributionRequestSchema
>;
export type MoveContributionRequest = z.infer<
  typeof moveContributionRequestSchema
>;
