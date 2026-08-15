import { z } from 'zod';

export const API_VERSION = 'v1' as const;
export const PERSISTED_SCHEMA_VERSION = 1 as const;

export const uuidV7Schema = z
  .string()
  .regex(
    /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    'Expected a canonical lowercase UUIDv7.',
  )
  .describe('Canonical lowercase RFC 9562 UUIDv7.');

export const utcInstantSchema = z.iso
  .datetime({ offset: false })
  .describe('UTC RFC 3339 instant with a trailing Z.');

export const positiveIntegerSchema = z.number().int().positive();
export const schemaVersionSchema = positiveIntegerSchema.describe(
  'Version of the containing durable or event payload schema.',
);

export const jsonObjectSchema = z
  .record(z.string(), z.json())
  .describe('An explicitly extensible JSON object.');

export type UuidV7 = z.infer<typeof uuidV7Schema>;
export type UtcInstant = z.infer<typeof utcInstantSchema>;
export type JsonObject = z.infer<typeof jsonObjectSchema>;
