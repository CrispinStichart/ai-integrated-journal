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
  snippet: z.array(searchSnippetSegmentSchema).min(1),
  href: z.string().min(1),
});

export const lexicalSearchPageSchema = z.strictObject({
  items: z.array(lexicalSearchResultSchema).max(50),
  page: z.strictObject({
    hasMore: z.boolean(),
    nextCursor: cursorSchema.optional(),
  }),
});

export type LexicalSearchRequest = z.infer<typeof lexicalSearchRequestSchema>;
export type LexicalSearchResult = z.infer<typeof lexicalSearchResultSchema>;
export type SearchLayer = z.infer<typeof searchLayerSchema>;
