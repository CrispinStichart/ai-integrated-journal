import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';
import { decimalCountSchema } from './recording.js';

export const exportStatusSchema = z.enum([
  'queued',
  'running',
  'completed',
  'failed',
  'invalidated',
  'expired',
]);

export const createExportRequestSchema = z.strictObject({
  includeAudio: z.boolean().default(false),
  includeProviderRawResponses: z.boolean().default(false),
});

export const exportResourceSchema = z.strictObject({
  id: uuidV7Schema,
  status: exportStatusSchema,
  manifestSchemaVersion: z.literal(1),
  snapshotAt: utcInstantSchema,
  createdAt: utcInstantSchema,
  expiresAt: utcInstantSchema,
  includeAudio: z.boolean(),
  includeProviderRawResponses: z.boolean(),
  entityCount: z.number().int().nonnegative(),
  fileCount: z.number().int().nonnegative(),
  archiveByteSize: decimalCountSchema.optional(),
  archiveSha256: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  completedAt: utcInstantSchema.optional(),
  invalidatedAt: utcInstantSchema.optional(),
  errorCode: z.string().min(1).max(100).optional(),
  downloadAvailable: z.boolean(),
});

export const exportMutationResponseSchema = z.strictObject({
  export: exportResourceSchema,
  idempotency: idempotencyResponseMetadataSchema,
});

export const exportListResponseSchema = z.strictObject({
  items: z.array(exportResourceSchema),
});

export type CreateExportRequest = z.infer<typeof createExportRequestSchema>;
export type ExportResource = z.infer<typeof exportResourceSchema>;
