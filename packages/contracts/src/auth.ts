import { z } from 'zod';

import { utcInstantSchema } from './primitives.js';

export const passwordSchema = z.string().min(12).max(1024);
export const recoveryCodeSchema = z
  .string()
  .trim()
  .regex(/^[A-Z2-9]{5}(?:-[A-Z2-9]{5}){3}$/i);

export const bootstrapRequestSchema = z.strictObject({
  displayName: z.string().trim().min(1).max(100),
  password: passwordSchema,
  journalTimeZone: z.string().trim().min(1).max(100),
});

export const passwordLoginRequestSchema = z.strictObject({
  password: z.string().min(1).max(1024),
});

export const passwordRecoveryRequestSchema = z.strictObject({
  recoveryCode: recoveryCodeSchema,
  newPassword: passwordSchema,
});

export const authStatusResponseSchema = z.strictObject({
  bootstrapRequired: z.boolean(),
  authenticated: z.boolean(),
  displayName: z.string().optional(),
  csrfToken: z.string().min(32).optional(),
  sessionExpiresAt: utcInstantSchema.optional(),
  passkeyCount: z.number().int().nonnegative().optional(),
});

export const authenticatedResponseSchema = z.strictObject({
  displayName: z.string(),
  csrfToken: z.string().min(32),
  sessionExpiresAt: utcInstantSchema,
  recoveryCodes: z.array(recoveryCodeSchema).optional(),
});

export const passkeyOptionsResponseSchema = z.strictObject({
  options: z.record(z.string(), z.unknown()),
});

export const passkeyVerificationRequestSchema = z.strictObject({
  response: z.record(z.string(), z.unknown()),
});

export const logoutResponseSchema = z.strictObject({
  loggedOut: z.literal(true),
});

export type AuthStatusResponse = z.infer<typeof authStatusResponseSchema>;
export type AuthenticatedResponse = z.infer<typeof authenticatedResponseSchema>;
