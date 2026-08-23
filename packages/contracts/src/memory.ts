import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { cursorPageMetadataSchema } from './pagination.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const memoryTypeSchema = z.enum([
  'transcription_context',
  'known_entity',
  'alias',
  'correction_rule',
  'processor_rule',
  'known_fact',
  'application_preference',
]);
export const memoryApprovalStateSchema = z.enum([
  'pending',
  'approved',
  'rejected',
]);
export const memoryCreatorSchema = z.enum(['user', 'ai']);
export const persistentMemoryScopeSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('global_transcription') }),
  z.strictObject({ kind: z.literal('processor'), processorId: uuidV7Schema }),
  z.strictObject({ kind: z.literal('global_known_fact') }),
  z.strictObject({ kind: z.literal('global_application_preference') }),
]);
export const feedbackScopeSchema = z.union([
  z.strictObject({ kind: z.literal('occurrence_only') }),
  persistentMemoryScopeSchema,
]);
export const feedbackTargetSchema = z.strictObject({
  kind: z.enum(['transcript_revision', 'artifact_version', 'processor_result']),
  id: uuidV7Schema,
});
const memoryDraftSchema = z.strictObject({
  type: memoryTypeSchema,
  content: z.string().trim().min(1).max(500),
  rationale: z.string().trim().min(1).max(500),
  scope: persistentMemoryScopeSchema,
});
export const createFeedbackRequestSchema = z.discriminatedUnion('mode', [
  z.strictObject({
    mode: z.literal('occurrence_only'),
    target: feedbackTargetSchema,
    message: z.string().trim().min(1).max(1_000),
  }),
  z.strictObject({
    mode: z.literal('correct_and_remember'),
    target: feedbackTargetSchema,
    message: z.string().trim().min(1).max(1_000),
    memory: memoryDraftSchema,
    approval: z.literal('approved'),
  }),
  z.strictObject({
    mode: z.literal('suggest_memory'),
    target: feedbackTargetSchema,
    message: z.string().trim().min(1).max(1_000),
    memory: memoryDraftSchema,
    suggestedBy: z.literal('ai'),
  }),
]);

export const memoryRevisionSchema = z.strictObject({
  id: uuidV7Schema,
  revision: z.number().int().positive(),
  type: memoryTypeSchema,
  content: z.string().min(1),
  rationale: z.string().min(1),
  creator: memoryCreatorSchema,
  approvalState: memoryApprovalStateSchema,
  scope: persistentMemoryScopeSchema,
  enabled: z.boolean(),
  deletedAt: utcInstantSchema.optional(),
  createdAt: utcInstantSchema,
});
export const memoryResourceSchema = z.strictObject({
  id: uuidV7Schema,
  revision: z.number().int().positive(),
  currentRevision: memoryRevisionSchema,
  history: z.array(memoryRevisionSchema).max(50),
  historyTruncated: z.boolean(),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});
export const memoryPageSchema = z.strictObject({
  items: z.array(memoryResourceSchema).max(50),
  page: cursorPageMetadataSchema,
});
export const memorySearchRequestSchema = z.strictObject({
  q: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: uuidV7Schema.optional(),
  includeDisabled: z.enum(['true', 'false']).optional(),
  includeDeleted: z.enum(['true', 'false']).optional(),
});
export const memoryMutationRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('edit'),
    memory: memoryDraftSchema,
  }),
  z.strictObject({ operation: z.literal('enable') }),
  z.strictObject({ operation: z.literal('disable') }),
  z.strictObject({ operation: z.literal('approve') }),
  z.strictObject({ operation: z.literal('delete') }),
]);
export const memoryMutationResponseSchema = z.strictObject({
  memory: memoryResourceSchema,
  idempotency: idempotencyResponseMetadataSchema,
});
export const feedbackResourceSchema = z.strictObject({
  id: uuidV7Schema,
  target: feedbackTargetSchema,
  message: z.string().min(1),
  classifiedScope: feedbackScopeSchema,
  memoryId: uuidV7Schema.optional(),
  createdAt: utcInstantSchema,
});
export const feedbackMutationResponseSchema = z.strictObject({
  feedback: feedbackResourceSchema,
  memory: memoryResourceSchema.optional(),
  idempotency: idempotencyResponseMetadataSchema,
});

export type CreateFeedbackRequest = z.infer<typeof createFeedbackRequestSchema>;
export type MemoryMutationRequest = z.infer<typeof memoryMutationRequestSchema>;
export type MemoryResource = z.infer<typeof memoryResourceSchema>;
export type FeedbackResource = z.infer<typeof feedbackResourceSchema>;
