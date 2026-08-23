import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

const jsonObjectSchema = z.record(z.string(), z.json());
export const artifactManualOperationSchema = z.enum([
  'confirm',
  'correct',
  'delete',
  'merge_result',
  'merge_source',
  'split_result',
  'split_source',
]);
const artifactJsonPointerSchema = z
  .string()
  .max(512)
  .regex(/^(?:|\/(?:[^/~]|~[01])+(?:\/(?:[^/~]|~[01])+)*)$/)
  .refine(
    (path) =>
      !path
        .slice(1)
        .split('/')
        .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'))
        .some((segment) =>
          ['__proto__', 'constructor', 'prototype'].includes(segment),
        ),
    'Artifact override path contains a forbidden segment.',
  );
export const artifactOverrideValueSchema = z.strictObject({
  path: artifactJsonPointerSchema,
  value: z.json(),
});
export const artifactVersionSchema = z.strictObject({
  id: uuidV7Schema,
  revision: z.number().int().positive(),
  authority: z.enum(['manual', 'generated']),
  lifecycle: z.enum(['active', 'superseded']),
  payload: jsonObjectSchema,
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  processorVersionId: uuidV7Schema.optional(),
  sourceResultId: uuidV7Schema.optional(),
  manualOperation: artifactManualOperationSchema.optional(),
  overridePaths: z.array(z.string()),
  staleAt: utcInstantSchema.optional(),
  createdAt: utcInstantSchema,
});
export const artifactCandidateSchema = z.strictObject({
  id: uuidV7Schema,
  versionId: uuidV7Schema,
  payload: jsonObjectSchema,
  payloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  status: z.enum(['reviewable', 'adopted', 'dismissed', 'superseded']),
  conflictsWithManualVersionId: uuidV7Schema,
  createdAt: utcInstantSchema,
});
export const artifactResourceSchema = z.strictObject({
  id: uuidV7Schema,
  processorId: uuidV7Schema,
  journalDayId: uuidV7Schema,
  contributionId: uuidV7Schema.optional(),
  logicalKey: z.string().min(1).max(256),
  kind: z.enum(['source_transform', 'observation', 'interpretation', 'other']),
  revision: z.number().int().nonnegative(),
  active: z.boolean(),
  deleted: z.boolean(),
  authority: z.enum(['manual', 'generated']),
  payload: jsonObjectSchema,
  manualOperation: artifactManualOperationSchema.optional(),
  overridePaths: z.array(z.string()),
  generatedCandidate: artifactCandidateSchema.optional(),
  candidates: z.array(artifactCandidateSchema),
  history: z.array(artifactVersionSchema),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});
export const artifactListResponseSchema = z.strictObject({
  items: z.array(artifactResourceSchema),
});

const manualResultSchema = z.strictObject({
  artifactId: uuidV7Schema,
  logicalKey: z
    .string()
    .min(1)
    .max(256)
    .regex(/^manual:[A-Za-z0-9._:-]+$/),
  payload: jsonObjectSchema,
});
export const artifactEditRequestSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('correct'),
    overrides: z.array(artifactOverrideValueSchema).min(1).max(64),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    operation: z.literal('confirm'),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    operation: z.literal('delete'),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    operation: z.literal('adopt_candidate'),
    candidateId: uuidV7Schema,
    reason: z.string().trim().min(1).max(500).optional(),
  }),
  z.strictObject({
    operation: z.literal('dismiss_candidate'),
    candidateId: uuidV7Schema,
  }),
  z.strictObject({ operation: z.literal('release_override') }),
  z.strictObject({
    operation: z.literal('split'),
    results: z.array(manualResultSchema).min(2).max(32),
    reason: z.string().trim().min(1).max(500).optional(),
  }),
]);
export const artifactMergeRequestSchema = z.strictObject({
  sourceArtifactIds: z
    .array(uuidV7Schema)
    .min(2)
    .max(32)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Merge source artifacts must be unique.',
    }),
  result: manualResultSchema,
  reason: z.string().trim().min(1).max(500).optional(),
});
export const artifactMutationResponseSchema = z.strictObject({
  artifacts: z.array(artifactResourceSchema),
  idempotency: idempotencyResponseMetadataSchema,
});

export type ArtifactEditRequest = z.infer<typeof artifactEditRequestSchema>;
export type ArtifactMergeRequest = z.infer<typeof artifactMergeRequestSchema>;
export type ArtifactResource = z.infer<typeof artifactResourceSchema>;
