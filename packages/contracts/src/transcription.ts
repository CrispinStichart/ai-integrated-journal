import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const recordingTranscriptionSchema = z.strictObject({
  state: z.enum(['not_started', 'queued', 'running', 'succeeded', 'failed']),
  runId: uuidV7Schema.optional(),
});

export const transcriptLayerSchema = z.enum([
  'raw_stt',
  'corrected',
  'cleaned',
]);
export const transcriptRunStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
  'stale',
]);
export const transcriptTimingSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('unknown') }),
  z.strictObject({
    status: z.literal('known'),
    startMilliseconds: z.string().regex(/^(?:0|[1-9][0-9]*)$/),
    endMilliseconds: z.string().regex(/^[1-9][0-9]*$/),
  }),
]);
export const transcriptSegmentSchema = z.strictObject({
  id: uuidV7Schema,
  sourceSegmentId: uuidV7Schema.optional(),
  ordinal: z.number().int().nonnegative(),
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().positive(),
  quote: z.string().min(1),
  timing: transcriptTimingSchema,
});
export const transcriptRevisionSchema = z.strictObject({
  id: uuidV7Schema,
  transcriptId: uuidV7Schema,
  revision: z.number().int().positive(),
  text: z.string(),
  authority: z.enum(['manual', 'generated']),
  authorId: uuidV7Schema.optional(),
  editReason: z.string().min(1).optional(),
  sourceRunId: uuidV7Schema.optional(),
  sourceRevisionId: uuidV7Schema.optional(),
  language: jsonObjectSchema,
  timingAvailability: jsonObjectSchema,
  segments: z.array(transcriptSegmentSchema),
  staleAt: utcInstantSchema.optional(),
  staleReason: z.string().min(1).optional(),
  createdAt: utcInstantSchema,
});
export const transcriptLayerResourceSchema = z.strictObject({
  id: uuidV7Schema,
  recordingId: uuidV7Schema,
  layer: transcriptLayerSchema,
  revisionCount: z.number().int().nonnegative(),
  currentRevision: transcriptRevisionSchema,
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});
export const transcriptProcessingRunSchema = z.strictObject({
  id: uuidV7Schema,
  stage: z.enum(['transcription', 'cleanup']),
  status: transcriptRunStatusSchema,
  attempt: z.number().int().positive(),
  retryable: z.boolean(),
  errorCode: z.string().min(1).optional(),
  provider: jsonObjectSchema.optional(),
  model: jsonObjectSchema.optional(),
  configuration: jsonObjectSchema.optional(),
  context: z
    .array(
      z.strictObject({
        text: z.string(),
        purpose: z.string(),
        version: z.string().optional(),
        memoryId: uuidV7Schema.optional(),
        memoryRevisionId: uuidV7Schema.optional(),
      }),
    )
    .optional(),
  prompt: z
    .strictObject({
      id: z.string().min(1),
      version: z.string().min(1),
      templateHash: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .optional(),
  processingTimeMilliseconds: z
    .string()
    .regex(/^(?:0|[1-9][0-9]*)$/)
    .optional(),
  sourceRevisionId: uuidV7Schema.optional(),
  queuedAt: utcInstantSchema,
  startedAt: utcInstantSchema.optional(),
  completedAt: utcInstantSchema.optional(),
});
export const recordingTranscriptInspectorSchema = z.strictObject({
  recordingId: uuidV7Schema,
  audioAvailable: z.boolean(),
  audioUnavailableReason: z
    .enum(['deleted', 'not_durable', 'missing'])
    .optional(),
  transcription: transcriptProcessingRunSchema.optional(),
  cleanup: transcriptProcessingRunSchema.optional(),
  rawStt: transcriptLayerResourceSchema.optional(),
  corrected: transcriptLayerResourceSchema.optional(),
  cleaned: transcriptLayerResourceSchema.optional(),
});
export const transcriptRevisionHistorySchema = z.strictObject({
  items: z.array(transcriptRevisionSchema),
});
export const editCorrectedTranscriptRequestSchema = z.strictObject({
  text: z.string().min(1),
  editReason: z.string().trim().min(1).optional(),
});
export const transcriptMutationResponseSchema = z.strictObject({
  inspector: recordingTranscriptInspectorSchema,
  idempotency: idempotencyResponseMetadataSchema,
});

export type RecordingTranscriptionResource = z.infer<
  typeof recordingTranscriptionSchema
>;
export type TranscriptLayer = z.infer<typeof transcriptLayerSchema>;
export type TranscriptSegmentResource = z.infer<typeof transcriptSegmentSchema>;
export type TranscriptRevisionResource = z.infer<
  typeof transcriptRevisionSchema
>;
export type TranscriptLayerResource = z.infer<
  typeof transcriptLayerResourceSchema
>;
export type TranscriptProcessingRunResource = z.infer<
  typeof transcriptProcessingRunSchema
>;
export type RecordingTranscriptInspector = z.infer<
  typeof recordingTranscriptInspectorSchema
>;
export type EditCorrectedTranscriptRequest = z.infer<
  typeof editCorrectedTranscriptRequestSchema
>;
