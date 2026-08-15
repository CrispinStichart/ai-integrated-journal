import { z } from 'zod';

import { sseEventEnvelopeSchema } from './events.js';
import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const healthStatusSchema = z.enum(['healthy', 'unhealthy']);

export const livenessResponseSchema = z.strictObject({
  status: z.literal('healthy'),
});

export const readinessResponseSchema = z.strictObject({
  status: healthStatusSchema,
});

export const healthDependencySchema = z.strictObject({
  status: z.enum(['healthy', 'unhealthy', 'not_configured']),
  detail: z.string().min(1).max(200).optional(),
});

export const healthDetailsResponseSchema = z.strictObject({
  status: healthStatusSchema,
  checkedAt: utcInstantSchema,
  dependencies: z.record(z.string().min(1), healthDependencySchema),
});

export const eventPollRequestSchema = z.strictObject({
  after: uuidV7Schema.optional(),
});

export const eventPollResponseSchema = z.strictObject({
  events: z.array(sseEventEnvelopeSchema),
  nextEventId: uuidV7Schema.optional(),
});

export type HealthStatus = z.infer<typeof healthStatusSchema>;
export type HealthDependency = z.infer<typeof healthDependencySchema>;
export type HealthDetailsResponse = z.infer<typeof healthDetailsResponseSchema>;
export type EventPollResponse = z.infer<typeof eventPollResponseSchema>;
