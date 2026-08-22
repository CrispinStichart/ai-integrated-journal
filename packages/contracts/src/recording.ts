import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import {
  ianaTimezoneSchema,
  journalDateAssignmentSchema,
  journalDateSchema,
} from './journal.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const RECORDING_PROTOCOL_VERSION = 1 as const;
export const MAX_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;
export const MAX_AUDIO_RANGE_BYTES = 8 * 1024 * 1024;

export const sha256Schema = z
  .string()
  .regex(/^[0-9a-f]{64}$/, 'Expected a lowercase SHA-256 hex digest.');
export const decimalCountSchema = z
  .string()
  .regex(/^(?:0|[1-9][0-9]*)$/, 'Expected a canonical non-negative decimal.')
  .refine((value) => BigInt(value) <= 9_223_372_036_854_775_807n, {
    error: 'Value exceeds PostgreSQL bigint capacity.',
  });
export const audioMimeTypeSchema = z
  .string()
  .min(1)
  .max(255)
  .regex(/^audio\/[A-Za-z0-9!#$&^_.+-]+(?:\s*;[^\r\n]+)?$/i);

export const createRecordingRequestSchema = z.strictObject({
  recordingId: uuidV7Schema,
  contributionId: uuidV7Schema,
  uploadId: uuidV7Schema,
  proposedJournalDayId: uuidV7Schema,
  mimeType: audioMimeTypeSchema,
  codec: z.string().trim().min(1).max(255).optional(),
  capturedAt: utcInstantSchema,
  capturedTimezone: ianaTimezoneSchema,
  journalTimezone: ianaTimezoneSchema,
  journalDate: journalDateSchema,
  journalDateAssignment: journalDateAssignmentSchema,
});

export const recordingPersistenceStateSchema = z.enum([
  'uploading',
  'prepared',
  'durable',
]);
export const recordingSchema = z.strictObject({
  id: uuidV7Schema,
  contributionId: uuidV7Schema,
  uploadId: uuidV7Schema,
  mimeType: audioMimeTypeSchema,
  codec: z.string().min(1).optional(),
  persistenceState: recordingPersistenceStateSchema,
  durationMilliseconds: decimalCountSchema.optional(),
  byteSize: decimalCountSchema.optional(),
  sha256: sha256Schema.optional(),
  audioDeletedAt: utcInstantSchema.optional(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});
export const recordingMutationResponseSchema = z.strictObject({
  recording: recordingSchema,
  idempotency: idempotencyResponseMetadataSchema,
});

export const recordingChunkSchema = z.strictObject({
  index: z.number().int().nonnegative(),
  byteSize: decimalCountSchema,
  sha256: sha256Schema,
});
export const recordingChunkUploadResponseSchema = z.strictObject({
  chunk: recordingChunkSchema,
  replayed: z.boolean(),
});
export const recordingUploadStatusSchema = z.strictObject({
  recording: recordingSchema,
  acceptedIndexes: z.array(z.number().int().nonnegative()),
  nextAfter: z.number().int().nonnegative().optional(),
});

export const finalizeRecordingRequestSchema = z.strictObject({
  manifestVersion: z.literal(RECORDING_PROTOCOL_VERSION),
  chunkCount: decimalCountSchema,
  totalBytes: decimalCountSchema,
  manifestSha256: sha256Schema,
  finalSha256: sha256Schema,
  durationMilliseconds: decimalCountSchema.optional(),
});
export const audioDeletionResponseSchema = z.strictObject({
  recording: recordingSchema,
  warning: z.literal(
    'Audio verification and timestamp playback are unavailable while audio is deleted.',
  ),
  idempotency: idempotencyResponseMetadataSchema,
});

export type CreateRecordingRequest = z.infer<
  typeof createRecordingRequestSchema
>;
export type RecordingResource = z.infer<typeof recordingSchema>;
export type FinalizeRecordingRequest = z.infer<
  typeof finalizeRecordingRequestSchema
>;
