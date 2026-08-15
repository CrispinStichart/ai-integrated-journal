import { z } from 'zod';

export const idempotencyKeySchema = z
  .string()
  .min(8)
  .max(255)
  .regex(/^[\x21-\x7e]+$/, 'Expected visible ASCII without whitespace.')
  .describe('Opaque key scoped to the authenticated actor and operation.');

export const strongEtagSchema = z
  .string()
  .regex(
    /^"(?:[\u0021\u0023-\u007e]|[\u0080-\u00ff])+"$/,
    'Expected one strong HTTP entity tag.',
  )
  .describe('Strong HTTP entity tag; weak W/ validators are rejected.');

export const idempotentMutationHeadersSchema = z.strictObject({
  'idempotency-key': idempotencyKeySchema,
});
export const conditionalMutationHeadersSchema =
  idempotentMutationHeadersSchema.extend({
    'if-match': strongEtagSchema,
  });
export const editableResponseHeadersSchema = z.strictObject({
  etag: strongEtagSchema,
});
export const idempotencyResponseMetadataSchema = z.strictObject({
  key: idempotencyKeySchema,
  replayed: z.boolean(),
});

export type IdempotentMutationHeaders = z.infer<
  typeof idempotentMutationHeadersSchema
>;
export type ConditionalMutationHeaders = z.infer<
  typeof conditionalMutationHeadersSchema
>;
export type EditableResponseHeaders = z.infer<
  typeof editableResponseHeadersSchema
>;
export type IdempotencyResponseMetadata = z.infer<
  typeof idempotencyResponseMetadataSchema
>;
