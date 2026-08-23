import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { createCursorPageSchema } from './pagination.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

const journalDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const boundedRangeSchema = z.strictObject({
  startDate: journalDateSchema,
  endDate: journalDateSchema,
});

export const reprocessingScopeSchema = z.discriminatedUnion('scope', [
  z.strictObject({
    scope: z.literal('contribution'),
    contributionId: uuidV7Schema,
  }),
  z.strictObject({
    scope: z.literal('journal_day'),
    journalDate: journalDateSchema,
  }),
  z.strictObject({
    scope: z.literal('date_range'),
    ...boundedRangeSchema.shape,
  }),
  z.strictObject({
    scope: z.literal('processor'),
    processorId: uuidV7Schema,
    ...boundedRangeSchema.shape,
  }),
  z.strictObject({
    scope: z.literal('processor_version'),
    processorVersionId: uuidV7Schema,
    ...boundedRangeSchema.shape,
  }),
]);

export const reprocessingVersionBasisRequestSchema = z.discriminatedUnion(
  'mode',
  [
    z.strictObject({
      mode: z.literal('current'),
      processorIds: z.array(uuidV7Schema).max(64).optional(),
    }),
    z.strictObject({
      mode: z.literal('pinned'),
      processorVersionIds: z.array(uuidV7Schema).min(1).max(64),
    }),
  ],
);

export const reprocessingPreviewRequestSchema = z.strictObject({
  target: reprocessingScopeSchema,
  versionBasis: reprocessingVersionBasisRequestSchema,
});

export const reprocessingVersionBasisSchema = z.strictObject({
  mode: z.enum(['current', 'pinned']),
  versions: z
    .array(
      z.strictObject({
        processorId: uuidV7Schema,
        processorName: z.string().min(1).max(120),
        processorVersionId: uuidV7Schema,
        semanticVersion: z
          .string()
          .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
        inputScope: z.enum(['contribution', 'journal_day']),
        providerOperationsPerRun: z.number().int().min(0).max(3),
      }),
    )
    .min(1)
    .max(64),
});

export const reprocessingImpactSchema = z.strictObject({
  journalDayCount: z.number().int().nonnegative(),
  contributionCount: z.number().int().nonnegative(),
  runCount: z.number().int().nonnegative().max(10_000),
  approximateProviderOperationCount: z.number().int().nonnegative(),
  staleArtifactCount: z.number().int().nonnegative(),
  manualOverrideCount: z.number().int().nonnegative(),
});

export const reprocessingPreviewResponseSchema = z.strictObject({
  target: reprocessingScopeSchema,
  versionBasis: reprocessingVersionBasisSchema,
  impact: reprocessingImpactSchema,
  impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  warnings: z.array(z.string().min(1).max(300)).max(10),
  expiresAt: utcInstantSchema,
});

export const startReprocessingRequestSchema = z.strictObject({
  preview: reprocessingPreviewRequestSchema,
  impactFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
});

export const reprocessingBatchStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'completed_with_failures',
  'canceled',
]);

export const reprocessingBatchSchema = z.strictObject({
  id: uuidV7Schema,
  revision: z.number().int().positive(),
  status: reprocessingBatchStatusSchema,
  target: reprocessingScopeSchema,
  versionBasis: reprocessingVersionBasisSchema,
  impact: reprocessingImpactSchema,
  progress: z.strictObject({
    total: z.number().int().nonnegative(),
    queued: z.number().int().nonnegative(),
    running: z.number().int().nonnegative(),
    succeeded: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    canceled: z.number().int().nonnegative(),
    percent: z.number().min(0).max(100),
  }),
  cancelRequestedAt: utcInstantSchema.optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
  completedAt: utcInstantSchema.optional(),
});

export const reprocessingBatchMutationResponseSchema = z.strictObject({
  batch: reprocessingBatchSchema,
  idempotency: idempotencyResponseMetadataSchema,
});

export const reprocessingBatchPageSchema = createCursorPageSchema(
  reprocessingBatchSchema,
);

export type ReprocessingPreviewRequest = z.infer<
  typeof reprocessingPreviewRequestSchema
>;
export type ReprocessingPreviewResponse = z.infer<
  typeof reprocessingPreviewResponseSchema
>;
export type ReprocessingBatch = z.infer<typeof reprocessingBatchSchema>;
