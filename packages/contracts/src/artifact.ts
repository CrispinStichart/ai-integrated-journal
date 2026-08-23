import { z } from 'zod';

import { idempotencyResponseMetadataSchema } from './http-metadata.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

const jsonObjectSchema = z.record(z.string(), z.json());
export const artifactManualOperationSchema = z.enum([
  'add',
  'confirm',
  'correct',
  'delete',
  'merge_result',
  'merge_source',
  'pin',
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
export const artifactEvidenceSchema = z.strictObject({
  id: uuidV7Schema,
  ordinal: z.number().int().nonnegative(),
  sourceLabel: z.string().min(1),
  sourceType: z.enum([
    'typed_text',
    'corrected_transcript',
    'cleaned_transcript',
  ]),
  sourceRevisionId: uuidV7Schema,
  normalization: z.literal('NFC_LF_V1'),
  offsetUnit: z.literal('utf16_code_unit'),
  startUtf16: z.number().int().nonnegative(),
  endUtf16: z.number().int().positive(),
  quote: z.string().min(1),
  quoteHash: z.string().regex(/^[0-9a-f]{64}$/),
  resolutionStatus: z.enum(['resolved', 'unresolved', 'stale']),
  unresolvedReason: z.string().optional(),
  audioRange: z
    .strictObject({
      startMs: z.number().int().nonnegative(),
      endMs: z.number().int().positive(),
    })
    .optional(),
});
export const artifactProvenanceSchema = z.strictObject({
  resultId: uuidV7Schema,
  runId: uuidV7Schema,
  processorKey: z.string().min(1),
  processorName: z.string().min(1),
  processorVersionId: uuidV7Schema,
  semanticVersion: z.string().min(1),
  instructionHash: z.string().regex(/^[0-9a-f]{64}$/),
  promptTemplateHash: z.string().regex(/^[0-9a-f]{64}$/),
  provider: jsonObjectSchema.optional(),
  model: jsonObjectSchema.optional(),
  processingTimeMilliseconds: z.number().int().nonnegative().optional(),
  completedAt: utcInstantSchema.optional(),
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
  evidence: z.array(artifactEvidenceSchema),
  provenance: artifactProvenanceSchema.optional(),
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
  z.strictObject({ operation: z.literal('pin'), pinned: z.boolean() }),
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
export const manualAccomplishmentPayloadSchema = z.strictObject({
  bulletKey: z.string().regex(/^manual:[A-Za-z0-9._:-]+$/),
  artifactType: z.enum(['accomplishment', 'notable_event']),
  text: z.string().trim().min(1).max(500),
  completionBasis: z.literal('user_authored'),
  significanceBasis: z.literal('user_authored'),
  pinned: z.boolean(),
  evidenceOrdinals: z.array(z.number().int().nonnegative()).max(64),
});
export const artifactAddRequestSchema = z.strictObject({
  artifactId: uuidV7Schema,
  processorKey: z.literal('accomplishments'),
  logicalKey: z
    .string()
    .min(1)
    .max(256)
    .regex(/^manual:accomplishment:[A-Za-z0-9._:-]+$/),
  kind: z.literal('interpretation'),
  payload: manualAccomplishmentPayloadSchema,
});
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
export type ArtifactAddRequest = z.infer<typeof artifactAddRequestSchema>;
export type ArtifactMergeRequest = z.infer<typeof artifactMergeRequestSchema>;
export type ArtifactResource = z.infer<typeof artifactResourceSchema>;
