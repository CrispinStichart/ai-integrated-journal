import { z } from 'zod';

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;

export const cursorSchema = z
  .string()
  .min(1)
  .max(2_048)
  .regex(/^[A-Za-z0-9_-]+$/, 'Expected an opaque base64url cursor.')
  .describe('Opaque, server-issued deterministic pagination cursor.');

export const cursorPaginationRequestSchema = z.strictObject({
  cursor: cursorSchema.optional(),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE),
});

export const cursorPageMetadataSchema = z.strictObject({
  hasMore: z.boolean(),
  nextCursor: cursorSchema.optional(),
});

export function createCursorPageSchema<Item extends z.ZodType>(
  itemSchema: Item,
) {
  return z.strictObject({
    items: z.array(itemSchema),
    page: cursorPageMetadataSchema,
  });
}

export type CursorPaginationRequest = z.infer<
  typeof cursorPaginationRequestSchema
>;
export type CursorPageMetadata = z.infer<typeof cursorPageMetadataSchema>;
