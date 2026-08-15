import { z } from 'zod';

import {
  jsonObjectSchema,
  schemaVersionSchema,
  utcInstantSchema,
  uuidV7Schema,
} from './primitives.js';

export const SSE_SCHEMA_VERSION = 1 as const;
export const eventTypeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/)
  .describe(
    'Extensible event type. Unknown types are handled through polling fallback.',
  );

export const sseEventEnvelopeSchema = z.strictObject({
  eventId: uuidV7Schema,
  eventType: eventTypeSchema,
  schemaVersion: z.literal(SSE_SCHEMA_VERSION),
  occurredAt: utcInstantSchema,
  payload: jsonObjectSchema,
});
export const lastEventIdSchema = uuidV7Schema.describe(
  'Last-Event-ID replay position supplied by an SSE client.',
);
export const unsupportedSseEventEnvelopeSchema = z.strictObject({
  eventId: uuidV7Schema,
  eventType: eventTypeSchema,
  schemaVersion: schemaVersionSchema.refine(
    (version) => version !== SSE_SCHEMA_VERSION,
    'Expected an unsupported schema version.',
  ),
  occurredAt: utcInstantSchema,
  payload: jsonObjectSchema,
});

export type SseEventEnvelope = z.infer<typeof sseEventEnvelopeSchema>;
