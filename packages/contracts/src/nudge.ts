import { z } from 'zod';

import { ianaTimezoneSchema, journalDateSchema } from './journal.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const requirementEvaluationStateSchema = z.enum([
  'not_evaluated',
  'satisfied',
  'insufficient_information',
  'pending_user_response',
  'dismissed',
  'not_applicable',
  'failed',
]);

export const requirementEvaluationSchema = z.strictObject({
  id: uuidV7Schema,
  journalDayId: uuidV7Schema,
  journalDate: journalDateSchema,
  processorId: uuidV7Schema,
  processorVersionId: uuidV7Schema,
  processorName: z.string().min(1).max(120),
  state: requirementEvaluationStateSchema,
  revision: z.number().int().positive(),
  allowNotApplicable: z.boolean(),
  prompt: z.string().min(1).max(500),
  supportingRunId: uuidV7Schema.optional(),
  responseContributionId: uuidV7Schema.optional(),
  evaluatedAt: utcInstantSchema.optional(),
  updatedAt: utcInstantSchema,
});

export const nudgeDigestStatusSchema = z.enum([
  'queued',
  'published',
  'deferred',
  'dismissed',
  'resolved',
]);

export const nudgeDigestItemSchema = z.strictObject({
  id: uuidV7Schema,
  evaluationId: uuidV7Schema,
  processorName: z.string().min(1).max(120),
  prompt: z.string().min(1).max(500),
  allowNotApplicable: z.boolean(),
  state: requirementEvaluationStateSchema,
});

export const nudgeDigestSchema = z.strictObject({
  id: uuidV7Schema,
  journalDayId: uuidV7Schema,
  journalDate: journalDateSchema,
  status: nudgeDigestStatusSchema,
  revision: z.number().int().positive(),
  scheduledAt: utcInstantSchema,
  publishedAt: utcInstantSchema.optional(),
  deferredUntil: utcInstantSchema.optional(),
  items: z.array(nudgeDigestItemSchema).min(1).max(32),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});

export const nudgeDayResourceSchema = z.strictObject({
  journalDate: journalDateSchema,
  evaluations: z.array(requirementEvaluationSchema),
  digest: nudgeDigestSchema.optional(),
});

export const nudgeDayQuerySchema = z.strictObject({
  journalDate: journalDateSchema,
});

export const nudgePreferenceSchema = z.strictObject({
  quietStartHour: z.number().int().min(0).max(23),
  quietEndHour: z.number().int().min(0).max(23),
  dailyLimit: z.number().int().min(0).max(24),
  revision: z.number().int().positive(),
  ownerTimezone: ianaTimezoneSchema,
  updatedAt: utcInstantSchema,
});

export const updateNudgePreferenceRequestSchema = z
  .strictObject({
    quietStartHour: z.number().int().min(0).max(23),
    quietEndHour: z.number().int().min(0).max(23),
    dailyLimit: z.number().int().min(0).max(24),
  })
  .refine((value) => value.quietStartHour !== value.quietEndHour, {
    message: 'Quiet hours must leave a delivery window.',
  });

export const nudgePreferenceMutationResponseSchema = z.strictObject({
  preference: nudgePreferenceSchema,
  idempotency: z.strictObject({
    key: z.string().min(8).max(255),
    replayed: z.boolean(),
  }),
});

const actionContributionSchema = z.strictObject({
  contributionId: uuidV7Schema,
  revisionId: uuidV7Schema,
  capturedAt: utcInstantSchema,
  capturedTimezone: ianaTimezoneSchema,
});

export const nudgeActionRequestSchema = z.discriminatedUnion('action', [
  actionContributionSchema.extend({
    action: z.literal('answer'),
    itemId: uuidV7Schema,
    text: z.string().trim().min(1).max(20_000),
  }),
  actionContributionSchema.extend({
    action: z.literal('defer'),
    deferredUntil: utcInstantSchema,
  }),
  actionContributionSchema.extend({ action: z.literal('dismiss') }),
  actionContributionSchema.extend({
    action: z.literal('not_applicable'),
    itemId: uuidV7Schema,
  }),
]);

export const nudgeMutationResponseSchema = z.strictObject({
  day: nudgeDayResourceSchema,
  responseContributionId: uuidV7Schema,
  idempotency: z.strictObject({
    key: z.string().min(8).max(255),
    replayed: z.boolean(),
  }),
});

export type RequirementEvaluationResource = z.infer<
  typeof requirementEvaluationSchema
>;
export type NudgeDigestResource = z.infer<typeof nudgeDigestSchema>;
export type NudgeDayResource = z.infer<typeof nudgeDayResourceSchema>;
export type NudgeActionRequest = z.infer<typeof nudgeActionRequestSchema>;
export type NudgePreference = z.infer<typeof nudgePreferenceSchema>;
export type UpdateNudgePreferenceRequest = z.infer<
  typeof updateNudgePreferenceRequestSchema
>;
