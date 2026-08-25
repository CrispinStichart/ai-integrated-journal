import { z } from 'zod';

import { cursorSchema } from './pagination.js';
import { journalDateSchema } from './journal.js';
import { uuidV7Schema } from './primitives.js';

export const searchLayerSchema = z.enum([
  'typed_text',
  'nudge_response',
  'raw_stt',
  'corrected',
  'cleaned',
  'observation',
  'interpretation',
  'summary',
  'memory',
]);
export const searchAuthoritySchema = z.enum(['manual', 'generated']);
export const searchModeSchema = z.enum(['lexical', 'semantic', 'hybrid']);
export const searchFallbackReasonSchema = z.enum([
  'provider_unavailable',
  'provider_failed',
  'semantic_index_unavailable',
]);
export const searchSourceKindSchema = z.enum([
  'contribution_revision',
  'transcript_revision',
  'artifact_version',
  'artifact_manual_revision',
  'memory_revision',
]);
export const searchContributionTypeSchema = z.enum([
  'typed_text',
  'recording',
  'nudge_response',
]);

export const lexicalSearchRequestSchema = z
  .strictObject({
    q: z.string().trim().min(1).max(200),
    mode: searchModeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
    cursor: cursorSchema.optional(),
    layers: z
      .string()
      .transform((value) => value.split(',').filter(Boolean))
      .pipe(z.array(searchLayerSchema).min(1))
      .optional(),
    dateFrom: journalDateSchema.optional(),
    dateTo: journalDateSchema.optional(),
    contributionTypes: z
      .string()
      .transform((value) => value.split(',').filter(Boolean))
      .pipe(z.array(searchContributionTypeSchema).min(1))
      .optional(),
    processorId: uuidV7Schema.optional(),
    resultType: z.string().trim().min(1).max(80).optional(),
    entity: z.string().trim().min(1).max(100).optional(),
    authority: searchAuthoritySchema.optional(),
  })
  .refine(
    ({ dateFrom, dateTo }) =>
      dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo,
    { message: 'dateFrom must be on or before dateTo.', path: ['dateTo'] },
  );

export const searchSnippetSegmentSchema = z.strictObject({
  text: z.string(),
  highlighted: z.boolean(),
});

export const lexicalSearchResultSchema = z.strictObject({
  fragmentId: uuidV7Schema,
  sourceKind: searchSourceKindSchema,
  layer: searchLayerSchema,
  sourceId: uuidV7Schema,
  sourceRevisionId: uuidV7Schema,
  sourceRevision: z.number().int().positive(),
  journalDate: journalDateSchema.optional(),
  contributionId: uuidV7Schema.optional(),
  transcriptId: uuidV7Schema.optional(),
  artifactId: uuidV7Schema.optional(),
  memoryId: uuidV7Schema.optional(),
  processorId: uuidV7Schema.optional(),
  processorVersionId: uuidV7Schema.optional(),
  processorName: z.string().min(1).optional(),
  contributionType: searchContributionTypeSchema.optional(),
  resultType: z.string().min(1).optional(),
  authority: searchAuthoritySchema,
  score: z.number().nonnegative(),
  retrievalSignals: z
    .strictObject({
      lexicalRank: z.number().int().positive().max(200).optional(),
      semanticRank: z.number().int().positive().max(200).optional(),
    })
    .optional(),
  snippet: z.array(searchSnippetSegmentSchema).min(1),
  href: z.string().min(1),
});

export const lexicalSearchPageSchema = z.strictObject({
  items: z.array(lexicalSearchResultSchema).max(50),
  retrieval: z.strictObject({
    requestedMode: searchModeSchema,
    effectiveMode: searchModeSchema,
    fallbackReason: searchFallbackReasonSchema.optional(),
    cohort: z
      .strictObject({
        providerId: z.string().min(1).max(120),
        modelId: z.string().min(1).max(120),
        modelVersion: z.string().min(1).max(120).optional(),
        dimension: z.number().int().min(1).max(4096),
        configurationFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
      })
      .optional(),
  }),
  page: z.strictObject({
    hasMore: z.boolean(),
    nextCursor: cursorSchema.optional(),
  }),
});

export const groundedAnswerStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'insufficient_support',
  'failed',
]);

export const groundedAnswerRequestSchema = z
  .strictObject({
    question: z.string().trim().min(1).max(200),
    mode: searchModeSchema.default('hybrid'),
    layers: z.array(searchLayerSchema).min(1).max(9).optional(),
    dateFrom: journalDateSchema.optional(),
    dateTo: journalDateSchema.optional(),
    contributionTypes: z.array(searchContributionTypeSchema).min(1).optional(),
    processorId: uuidV7Schema.optional(),
    resultType: z.string().trim().min(1).max(80).optional(),
    entity: z.string().trim().min(1).max(100).optional(),
    authority: searchAuthoritySchema.optional(),
  })
  .refine(
    ({ dateFrom, dateTo }) =>
      dateFrom === undefined || dateTo === undefined || dateFrom <= dateTo,
    { message: 'dateFrom must be on or before dateTo.', path: ['dateTo'] },
  );

export const groundedAnswerCitationSchema = z.strictObject({
  citationId: z.string().regex(/^cite_[0-9a-f]{32}$/),
  sourceKind: searchSourceKindSchema,
  layer: searchLayerSchema,
  sourceId: uuidV7Schema,
  sourceRevisionId: uuidV7Schema,
  sourceRevision: z.number().int().positive(),
  journalDate: journalDateSchema.optional(),
  authority: searchAuthoritySchema,
  retrievedQuote: z.string().min(1).max(2_000),
  evidence: z.strictObject({
    normalization: z.literal('NFC_LF_V1'),
    offsetUnit: z.literal('utf16_code_unit'),
    startUtf16: z.number().int().nonnegative(),
    endUtf16: z.number().int().positive(),
    quoteSha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  href: z.string().min(1),
});

export const groundedAnswerLineageSchema = z.strictObject({
  prompt: z.strictObject({
    id: z.literal('grounded-answer'),
    version: z.string().min(1),
    templateHash: z.string().regex(/^[0-9a-f]{64}$/),
    effectiveMessagesHash: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  provider: z.record(z.string(), z.unknown()),
  model: z.record(z.string(), z.unknown()),
  effectiveConfiguration: z.record(z.string(), z.unknown()),
  usage: z.record(z.string(), z.unknown()),
  processingTimeMilliseconds: z.number().int().nonnegative(),
  rawResponse: z.strictObject({
    id: uuidV7Schema,
    mediaType: z.string().min(1),
    byteSize: z.string().regex(/^\d+$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    retention: z.string().min(1),
    expiresAt: z.iso.datetime(),
  }),
});

export const groundedAnswerSchema = z.strictObject({
  id: uuidV7Schema,
  question: z.string().min(1).max(200),
  status: groundedAnswerStatusSchema,
  retrieval: lexicalSearchPageSchema.shape.retrieval,
  synthesis: z.string().min(1).max(8_000).optional(),
  citations: z.array(groundedAnswerCitationSchema).max(8),
  failureCode: z.string().min(1).max(120).optional(),
  lineage: groundedAnswerLineageSchema.optional(),
  requestedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
});

export type LexicalSearchRequest = z.infer<typeof lexicalSearchRequestSchema>;
export type LexicalSearchResult = z.infer<typeof lexicalSearchResultSchema>;
export type SearchLayer = z.infer<typeof searchLayerSchema>;
export type SearchMode = z.infer<typeof searchModeSchema>;
export type SearchFallbackReason = z.infer<typeof searchFallbackReasonSchema>;
export type SearchRetrievalMetadata = z.infer<
  typeof lexicalSearchPageSchema.shape.retrieval
>;
export type GroundedAnswerRequest = z.infer<typeof groundedAnswerRequestSchema>;
export type GroundedAnswer = z.infer<typeof groundedAnswerSchema>;
