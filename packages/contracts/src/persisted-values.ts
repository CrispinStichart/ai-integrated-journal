import { z } from 'zod';

import {
  jsonObjectSchema,
  PERSISTED_SCHEMA_VERSION,
  schemaVersionSchema,
} from './primitives.js';

export const persistedValueKindSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/);

/** Generic durable JSONB envelope whose payload is intentionally opaque. */
export const persistedExtensibleValueSchema = z.strictObject({
  schemaVersion: schemaVersionSchema,
  kind: persistedValueKindSchema,
  payload: jsonObjectSchema,
});

export function createPersistedValueSchema<
  Kind extends string,
  Payload extends z.ZodType,
>(kind: Kind, payloadSchema: Payload) {
  return z.strictObject({
    schemaVersion: z.literal(PERSISTED_SCHEMA_VERSION),
    kind: z.literal(kind),
    payload: payloadSchema,
  });
}

export type PersistedExtensibleValue = z.infer<
  typeof persistedExtensibleValueSchema
>;
