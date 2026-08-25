import { z } from 'zod';

import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const retentionEntityKindSchema = z.enum([
  'journal_day',
  'contribution',
  'recording_audio',
  'provider_raw_response',
]);
export const retentionFacetSchema = z.enum([
  'database',
  'final_blobs',
  'staging_chunks',
  'browser_cache',
  'browser_outbox',
  'search_text',
  'search_vectors',
  'exports',
  'backups',
  'provider_raw_responses',
  'audit',
  'tombstone',
]);
export const retentionActionSchema = z.enum([
  'delete',
  'invalidate',
  'retain',
  'retain_metadata',
]);

export const retentionTargetSchema = z.strictObject({
  entityKind: retentionEntityKindSchema,
  entityId: uuidV7Schema,
});

export const permanentDeletionPreviewRequestSchema = retentionTargetSchema;
export const permanentDeletionRequestSchema = retentionTargetSchema.extend({
  confirmation: z.literal('PERMANENTLY DELETE'),
});

export const retentionImpactSchema = z.strictObject({
  facet: retentionFacetSchema,
  action: retentionActionSchema,
  detail: z.string().min(1).max(500),
});

export const permanentDeletionPreviewSchema = z.strictObject({
  target: retentionTargetSchema,
  softDeletedAt: utcInstantSchema,
  eligibleAt: utcInstantSchema,
  eligible: z.boolean(),
  affectedContributionCount: z.number().int().nonnegative(),
  affectedRecordingCount: z.number().int().nonnegative(),
  impacts: z.array(retentionImpactSchema).min(1),
  warnings: z.array(z.string().min(1).max(500)),
});

export const deletionRequestStatusSchema = z.enum([
  'pending',
  'purging',
  'completed',
  'failed',
]);

export const permanentDeletionResourceSchema = z.strictObject({
  id: uuidV7Schema,
  target: retentionTargetSchema,
  status: deletionRequestStatusSchema,
  generation: z.number().int().positive(),
  requestedAt: utcInstantSchema,
  eligibleAt: utcInstantSchema,
  startedAt: utcInstantSchema.optional(),
  completedAt: utcInstantSchema.optional(),
  attempts: z.number().int().nonnegative(),
  backupCheckpoint: z.enum(['not_configured', 'pending', 'committed']),
  backupWarning: z.string().min(1).max(500).optional(),
  errorCode: z.string().min(1).max(100).optional(),
});

export const permanentDeletionMutationResponseSchema = z.strictObject({
  deletion: permanentDeletionResourceSchema,
  replayed: z.boolean(),
});

export const deletionTombstoneSchema = z.strictObject({
  entityKind: retentionEntityKindSchema,
  entityId: uuidV7Schema,
  deletedAt: utcInstantSchema,
  generation: z.number().int().positive(),
});

export const deletionTombstonePageSchema = z.strictObject({
  items: z.array(deletionTombstoneSchema),
  latestGeneration: z.number().int().nonnegative(),
  hasMore: z.boolean(),
});

export const browserPurgeAcknowledgementSchema = z.strictObject({
  generation: z.number().int().nonnegative(),
});

export type PermanentDeletionPreviewRequest = z.infer<
  typeof permanentDeletionPreviewRequestSchema
>;
export type PermanentDeletionRequest = z.infer<
  typeof permanentDeletionRequestSchema
>;
export type PermanentDeletionPreview = z.infer<
  typeof permanentDeletionPreviewSchema
>;
export type PermanentDeletionResource = z.infer<
  typeof permanentDeletionResourceSchema
>;
export type DeletionTombstone = z.infer<typeof deletionTombstoneSchema>;
