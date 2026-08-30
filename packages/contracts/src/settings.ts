import { z } from 'zod';

import { utcInstantSchema, uuidV7Schema } from './primitives.js';

export const providerCapabilitySchema = z.enum([
  'embeddings',
  'speech_to_text',
  'structured_generation',
]);

const disclosureValueSchema = <T extends z.ZodType>(value: T) =>
  z.discriminatedUnion('status', [
    z.strictObject({
      status: z.literal('known'),
      value,
      detail: z.string().min(1).max(1_000).optional(),
    }),
    z.strictObject({
      status: z.literal('unknown'),
      detail: z.string().min(1).max(1_000).optional(),
    }),
  ]);

export const providerDisclosureSchema = z.strictObject({
  contentRecipient: z.string().min(1).max(200),
  external: z.boolean(),
  retention: disclosureValueSchema(z.string().min(1).max(500)),
  trainingUse: disclosureValueSchema(z.boolean()),
  privacyPolicyUrl: z.url().optional(),
});

export const providerSettingsSchema = z.strictObject({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
  displayName: z.string().min(1).max(200),
  capabilities: z.array(providerCapabilitySchema).min(1),
  disclosure: providerDisclosureSchema,
  disclosureVersion: z.string().regex(/^[a-f0-9]{64}$/),
  enabled: z.boolean(),
  models: z.partialRecord(providerCapabilitySchema, z.string().min(1).max(200)),
  credentialConfigured: z.boolean(),
  credentialStorageAvailable: z.boolean(),
  disclosureAcceptedAt: utcInstantSchema.optional(),
  revision: z.number().int().positive(),
});

export const retentionSettingsSchema = z.strictObject({
  materialGraceDays: z.number().int().min(0).max(3_650),
  audioGraceDays: z.number().int().min(0).max(3_650),
  rawResponseRetention: z.enum([
    'do_not_retain',
    'days_30',
    'days_90',
    'year_1',
    'indefinite',
  ]),
  originalAudioRetention: z.enum([
    'indefinite',
    '30_days',
    '90_days',
    '365_days',
  ]),
});

export const backupSettingsSchema = z.strictObject({
  configured: z.boolean(),
  scheduleEnabled: z.boolean(),
  schedule: z.literal('03:30 UTC daily'),
  encrypted: z.literal(true),
  retentionSummary: z.literal('7 daily, 5 weekly, and 12 monthly snapshots'),
});

export const privacySettingsSchema = z.strictObject({
  journalPrivateByDefault: z.literal(true),
  contentFreeLogs: z.literal(true),
  credentialsExcludedFromExports: z.literal(true),
  externalProcessingRequiresProviderEnablement: z.literal(true),
  offlineCacheEncrypted: z.literal(true),
});

export const settingsResourceSchema = z.strictObject({
  revision: z.number().int().positive(),
  journalTimezone: z.string().min(1).max(100),
  retention: retentionSettingsSchema,
  backup: backupSettingsSchema,
  privacy: privacySettingsSchema,
  providers: z.array(providerSettingsSchema),
});

export const updateSettingsRequestSchema = z.strictObject({
  journalTimezone: z.string().trim().min(1).max(100),
  retention: retentionSettingsSchema,
  backupScheduleEnabled: z.boolean(),
});

export const settingsMutationResponseSchema = z.strictObject({
  settings: settingsResourceSchema,
  idempotency: z.strictObject({
    key: z.string().min(8).max(255),
    replayed: z.boolean(),
  }),
});

export const updateProviderSettingsRequestSchema = z
  .strictObject({
    enabled: z.boolean(),
    models: z.partialRecord(
      providerCapabilitySchema,
      z.string().trim().min(1).max(200),
    ),
    acknowledgeDisclosureVersion: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    credential: z.string().min(1).max(16_384).optional(),
    clearCredential: z.boolean().optional(),
  })
  .refine(
    (value) => !(value.credential !== undefined && value.clearCredential),
    { message: 'A credential cannot be replaced and cleared together.' },
  );

export const providerSettingsMutationResponseSchema = z.strictObject({
  provider: providerSettingsSchema,
  idempotency: z.strictObject({
    key: z.string().min(8).max(255),
    replayed: z.boolean(),
  }),
});

export const activeSessionSchema = z.strictObject({
  id: uuidV7Schema,
  current: z.boolean(),
  createdAt: utcInstantSchema,
  lastUsedAt: utcInstantSchema,
  idleExpiresAt: utcInstantSchema,
  absoluteExpiresAt: utcInstantSchema,
});

export const activeSessionListSchema = z.strictObject({
  sessions: z.array(activeSessionSchema),
});

export const revokeSessionResponseSchema = z.strictObject({
  revoked: z.literal(true),
  currentSession: z.boolean(),
});

export type ProviderCapability = z.infer<typeof providerCapabilitySchema>;
export type ProviderSettings = z.infer<typeof providerSettingsSchema>;
export type RetentionSettings = z.infer<typeof retentionSettingsSchema>;
export type SettingsResource = z.infer<typeof settingsResourceSchema>;
export type UpdateSettingsRequest = z.infer<typeof updateSettingsRequestSchema>;
export type UpdateProviderSettingsRequest = z.infer<
  typeof updateProviderSettingsRequestSchema
>;
export type ActiveSessionResource = z.infer<typeof activeSessionSchema>;
