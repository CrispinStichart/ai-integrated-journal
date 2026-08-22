import { z } from 'zod';

import { uuidV7Schema } from './primitives.js';

export const ERROR_CODES = [
  'validation_failed',
  'authentication_required',
  'forbidden',
  'not_found',
  'conflict',
  'idempotency_key_required',
  'idempotency_key_reused',
  'precondition_required',
  'etag_mismatch',
  'rate_limited',
  'unsupported_schema_version',
  'payload_too_large',
  'range_not_satisfiable',
  'recording_not_durable',
  'audio_deleted',
  'server_storage_exhausted',
  'service_unavailable',
  'internal_error',
] as const;

export const knownErrorCodeSchema = z.enum(ERROR_CODES);
export const errorCodeSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/)
  .describe(
    'Stable snake-case application code. This extension point is open so additive v1 errors remain compatible.',
  );
export const invalidParameterSchema = z.strictObject({
  name: z.string().min(1),
  location: z.enum(['body', 'header', 'path', 'query']),
  reason: z.string().min(1),
});

/** RFC 9457 fields plus stable application extensions. */
export const problemDetailsSchema = z
  .object({
    type: z.string().min(1),
    title: z.string().min(1),
    status: z.number().int().min(400).max(599),
    detail: z.string().min(1).optional(),
    instance: z.string().min(1).optional(),
    code: errorCodeSchema,
    correlationId: uuidV7Schema,
    invalidParameters: z.array(invalidParameterSchema).optional(),
  })
  .catchall(z.json())
  .describe(
    'RFC 9457 problem details. Consumers branch on status and code, not title or detail.',
  );

export type KnownErrorCode = z.infer<typeof knownErrorCodeSchema>;
export type ErrorCode = z.infer<typeof errorCodeSchema>;
export type InvalidParameter = z.infer<typeof invalidParameterSchema>;
export type ProblemDetails = z.infer<typeof problemDetailsSchema>;
