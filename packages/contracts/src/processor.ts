import { z } from 'zod';

import { uuidV7Schema, utcInstantSchema } from './primitives.js';

export const processorKindSchema = z.enum([
  'source_transform',
  'observation_extractor',
  'interpretation',
  'other',
]);
export const processorInputScopeSchema = z.enum([
  'contribution',
  'journal_day',
  'date_range',
  'observation_set',
  'artifact_set',
]);
export const processorInputSelectorSchema = z.enum([
  'typed_text',
  'corrected_transcript',
  'cleaned_transcript',
  'observations',
  'processor_results',
]);
export const processorReconciliationStrategySchema = z.enum([
  'replace_scope',
  'logical_key',
  'append_only',
]);
export const processorRequirementModeSchema = z.enum(['optional', 'required']);
export const processorCapabilitySchema = z.enum([
  'deterministic',
  'structured_generation',
  'embeddings',
]);

export const processorDependencySchema = z.strictObject({
  upstreamVersionId: uuidV7Schema,
  outputSelector: z
    .string()
    .min(1)
    .max(256)
    .regex(/^\/(?:[^~/]|~[01])+(?:\/(?:[^~/]|~[01])*)*$/),
  acceptPartial: z.boolean().default(false),
});

export const processorResourceLimitsSchema = z.strictObject({
  maxPromptChars: z.number().int().min(256).max(32_768),
  maxInputChars: z.number().int().min(1_024).max(200_000),
  maxRuntimeMs: z.number().int().min(100).max(120_000),
  maxResultBytes: z.number().int().min(256).max(1_048_576),
});

export const processorOutputSafetySchema = z.strictObject({
  mode: z.literal('data_only'),
  allowCodeExecution: z.literal(false),
  allowToolCalls: z.literal(false),
  allowSql: z.literal(false),
  allowHtml: z.literal(false),
});

export const processorDefinitionDraftSchema = z.strictObject({
  semanticVersion: z
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  kind: processorKindSchema,
  instructions: z.string().trim().min(1).max(16_000),
  input: z.strictObject({
    scope: processorInputScopeSchema,
    selectors: z
      .array(processorInputSelectorSchema)
      .min(1)
      .max(8)
      .refine((items) => new Set(items).size === items.length, {
        message: 'Input selectors must be unique.',
      }),
  }),
  dependencies: z.array(processorDependencySchema).max(32),
  outputSchemaVersion: z
    .string()
    .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/),
  outputSchema: z.record(z.string(), z.json()),
  reconciliation: z.strictObject({
    strategy: processorReconciliationStrategySchema,
    logicalKey: z
      .string()
      .trim()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z_][A-Za-z0-9_-]*$/)
      .optional(),
  }),
  requirementMode: processorRequirementModeSchema,
  defaultEnabled: z.boolean(),
  nudgePolicy: z.strictObject({
    enabled: z.boolean(),
    prompt: z.string().trim().min(1).max(500).optional(),
    allowNotApplicable: z.boolean(),
  }),
  capabilityRequirements: z
    .array(processorCapabilitySchema)
    .max(3)
    .refine((items) => new Set(items).size === items.length, {
      message: 'Capability requirements must be unique.',
    }),
  allowPartialInputs: z.boolean(),
  resourceLimits: processorResourceLimitsSchema,
  outputSafety: processorOutputSafetySchema,
});

export const processorValidationIssueSchema = z.strictObject({
  path: z.string(),
  code: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  message: z.string(),
});

export const processorDryRunRequestSchema = z.strictObject({
  processorId: uuidV7Schema.optional(),
  versionId: uuidV7Schema.optional(),
  definition: processorDefinitionDraftSchema,
});
export const processorDryRunResponseSchema = z.strictObject({
  valid: z.boolean(),
  draftHash: z.string().regex(/^[0-9a-f]{64}$/),
  issues: z.array(processorValidationIssueSchema),
  schemaComplexity: z.strictObject({
    depth: z.number().int().nonnegative(),
    nodes: z.number().int().nonnegative(),
  }),
  resolvedDependencyCount: z.number().int().nonnegative(),
  authoritative: z.literal(false),
});

export const processorVersionResourceSchema = z.strictObject({
  id: uuidV7Schema,
  processorId: uuidV7Schema,
  revision: z.number().int().positive(),
  definition: processorDefinitionDraftSchema,
  instructionHash: z.string().regex(/^[0-9a-f]{64}$/),
  outputSchemaHash: z.string().regex(/^[0-9a-f]{64}$/),
  promptTemplateHash: z.string().regex(/^[0-9a-f]{64}$/),
  createdBy: uuidV7Schema.optional(),
  createdAt: utcInstantSchema,
});

export const processorResourceSchema = z.strictObject({
  id: uuidV7Schema,
  key: z.string().min(1).max(80),
  name: z.string().min(1).max(120),
  purpose: z.string().min(1).max(1_000),
  enabled: z.boolean(),
  requirementMode: processorRequirementModeSchema,
  builtIn: z.boolean(),
  configRevision: z.number().int().positive(),
  currentVersionId: uuidV7Schema.optional(),
  currentVersion: processorVersionResourceSchema.optional(),
  versions: z.array(processorVersionResourceSchema),
  createdAt: utcInstantSchema,
  updatedAt: utcInstantSchema,
});

export const processorListResponseSchema = z.strictObject({
  items: z.array(processorResourceSchema),
});
export const createProcessorRequestSchema = z.strictObject({
  id: uuidV7Schema,
  versionId: uuidV7Schema,
  key: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  name: z.string().trim().min(1).max(120),
  purpose: z.string().trim().min(1).max(1_000),
  definition: processorDefinitionDraftSchema,
});
export const publishProcessorVersionRequestSchema = z.strictObject({
  versionId: uuidV7Schema,
  definition: processorDefinitionDraftSchema,
});
export const updateProcessorRequestSchema = z
  .strictObject({
    name: z.string().trim().min(1).max(120).optional(),
    purpose: z.string().trim().min(1).max(1_000).optional(),
    enabled: z.boolean().optional(),
    requirementMode: processorRequirementModeSchema.optional(),
    currentVersionId: uuidV7Schema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one processor setting is required.',
  });
export const processorMutationResponseSchema = z.strictObject({
  processor: processorResourceSchema,
  idempotency: z.strictObject({
    key: z.string(),
    replayed: z.boolean(),
  }),
});

const processorTemporalContextSchema = z.strictObject({
  capturedAt: utcInstantSchema,
  capturedTimezone: z.string().min(1),
  journalDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  journalTimezone: z.string().min(1),
  journalDateAssignment: z.enum(['default', 'user_override', 'migration']),
});

export const processorProvenanceInputSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  label: z.string().min(1),
  kind: z.enum([
    'typed_text',
    'corrected_transcript',
    'cleaned_transcript',
    'processor_result',
  ]),
  contributionRevisionId: uuidV7Schema.optional(),
  transcriptRevisionId: uuidV7Schema.optional(),
  processorResultId: uuidV7Schema.optional(),
  outputSelector: z.string().min(1).optional(),
  includedStartUtf16: z.number().int().nonnegative(),
  includedEndUtf16: z.number().int().nonnegative(),
  fullLengthUtf16: z.number().int().nonnegative(),
  contentHash: z.string().regex(/^[0-9a-f]{64}$/),
  temporalContext: processorTemporalContextSchema,
});

export const processorReconciliationOutcomeSchema = z.strictObject({
  ordinal: z.number().int().nonnegative(),
  logicalKey: z.string().min(1).max(256),
  outcome: z.enum([
    'create',
    'update',
    'supersede',
    'remove_supersede',
    'unchanged',
  ]),
  artifactId: uuidV7Schema,
  versionId: uuidV7Schema.optional(),
  priorVersionId: uuidV7Schema.optional(),
});

export const processorRunProvenanceSchema = z.strictObject({
  runId: uuidV7Schema,
  processorId: uuidV7Schema,
  processorVersionId: uuidV7Schema,
  processorSemanticVersion: z.string(),
  target: z.strictObject({
    scope: z.enum(['contribution', 'journal_day']),
    journalDayId: uuidV7Schema,
    contributionId: uuidV7Schema.optional(),
  }),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'canceled']),
  attempt: z.number().int().positive(),
  predecessorRunId: uuidV7Schema.optional(),
  inputFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  inputCompleteness: z.enum(['complete', 'partial']),
  inputs: z.array(processorProvenanceInputSchema),
  prompt: z.strictObject({
    assemblyVersion: z.string().min(1),
    templateHash: z.string().regex(/^[0-9a-f]{64}$/),
    instructionHash: z.string().regex(/^[0-9a-f]{64}$/),
    effectiveMessagesHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  }),
  requestedConfiguration: z.record(z.string(), z.json()),
  provider: z.record(z.string(), z.json()).optional(),
  model: z.record(z.string(), z.json()).optional(),
  effectiveConfiguration: z.record(z.string(), z.json()).optional(),
  result: z
    .strictObject({
      id: uuidV7Schema,
      kind: z.enum([
        'source_transform',
        'observation',
        'interpretation',
        'other',
      ]),
      completeness: z.enum(['complete', 'partial']),
      authority: z.enum(['manual', 'generated']),
      lifecycle: z.enum(['active', 'superseded']),
      staleAt: utcInstantSchema.optional(),
      staleReason: z.string().optional(),
      reconciliation: z
        .strictObject({
          strategy: processorReconciliationStrategySchema,
          completeness: z.enum(['complete', 'partial']),
          inputHash: z.string().regex(/^[0-9a-f]{64}$/),
          outcomes: z.array(processorReconciliationOutcomeSchema),
        })
        .optional(),
      createdAt: utcInstantSchema,
    })
    .optional(),
  queuedAt: utcInstantSchema,
  startedAt: utcInstantSchema.optional(),
  completedAt: utcInstantSchema.optional(),
});

export type ProcessorDefinitionDraft = z.infer<
  typeof processorDefinitionDraftSchema
>;
export type ProcessorDryRunResponse = z.infer<
  typeof processorDryRunResponseSchema
>;
export type ProcessorValidationIssue = z.infer<
  typeof processorValidationIssueSchema
>;
export type ProcessorResource = z.infer<typeof processorResourceSchema>;
export type ProcessorVersionResource = z.infer<
  typeof processorVersionResourceSchema
>;
export type ProcessorRunProvenance = z.infer<
  typeof processorRunProvenanceSchema
>;
