import { z } from 'zod';

/** Builds the canonical semantic-value wire/JSONB union from ADR-0003. */
export function createSemanticValueSchema<Value extends z.ZodType>(
  valueSchema: Value,
) {
  return z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('unknown') }),
    z.strictObject({ state: z.literal('known'), value: valueSchema }),
    z.strictObject({ state: z.literal('none') }),
    z.strictObject({ state: z.literal('neutral') }),
    z.strictObject({ state: z.literal('not_applicable') }),
    z.strictObject({
      state: z.literal('uncertain'),
      value: valueSchema.optional(),
      confidence: z.number().min(0).max(1).optional(),
    }),
  ]);
}

export const semanticJsonValueSchema = createSemanticValueSchema(z.json());
export type SemanticJsonValue = z.infer<typeof semanticJsonValueSchema>;
