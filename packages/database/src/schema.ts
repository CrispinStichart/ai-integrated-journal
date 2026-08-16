import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const journalSchema = pgSchema('journal');

export const authChallengePurpose = pgEnum('auth_challenge_purpose', [
  'passkey_registration',
  'passkey_authentication',
]);

export const contributionSourceType = pgEnum('contribution_source_type', [
  'typed_text',
  'recording',
  'nudge_response',
]);

export const contributionAuthority = pgEnum('contribution_authority', [
  'manual',
  'generated',
]);

export const journalDateAssignment = pgEnum('journal_date_assignment', [
  'default',
  'user_override',
  'migration',
]);

export const users = journalSchema.table(
  'user',
  {
    id: uuid('id').primaryKey(),
    singleton: boolean('singleton').notNull().default(true),
    displayName: text('display_name').notNull(),
    locale: text('locale').notNull().default('en'),
    journalTimeZone: text('journal_time_zone').notNull().default('UTC'),
    preferencesVersion: integer('preferences_version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('user_singleton_unique').on(table.singleton),
    check('user_singleton_true', sql`${table.singleton} = true`),
    check(
      'user_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('user_display_name_not_blank', sql`length(${table.displayName}) > 0`),
    check(
      'user_preferences_version_positive',
      sql`${table.preferencesVersion} > 0`,
    ),
  ],
);

export const passwordCredentials = journalSchema.table('password_credential', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  passwordHash: text('password_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const authenticators = journalSchema.table(
  'authenticator',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    credentialId: text('credential_id').notNull(),
    publicKey: text('public_key').notNull(),
    counter: bigint('counter', { mode: 'number' }).notNull().default(0),
    transports: text('transports').array().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('authenticator_credential_id_unique').on(table.credentialId),
    index('authenticator_user_id_idx').on(table.userId),
    check(
      'authenticator_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('authenticator_counter_valid', sql`${table.counter} >= 0`),
  ],
);

export const recoveryCodes = journalSchema.table(
  'recovery_code',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    codeHash: text('code_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    usedAt: timestamp('used_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('recovery_code_hash_unique').on(table.codeHash),
    index('recovery_code_user_id_idx').on(table.userId),
    check(
      'recovery_code_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
  ],
);

export const sessions = journalSchema.table(
  'session',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    csrfTokenHash: text('csrf_token_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastUsedAt: timestamp('last_used_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    idleExpiresAt: timestamp('idle_expires_at', {
      withTimezone: true,
    }).notNull(),
    absoluteExpiresAt: timestamp('absolute_expires_at', {
      withTimezone: true,
    }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('session_token_hash_unique').on(table.tokenHash),
    index('session_user_id_idx').on(table.userId),
    index('session_expiry_idx').on(table.absoluteExpiresAt),
    check(
      'session_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'session_idle_before_absolute',
      sql`${table.idleExpiresAt} <= ${table.absoluteExpiresAt}`,
    ),
  ],
);

export const authChallenges = journalSchema.table(
  'auth_challenge',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    purpose: authChallengePurpose('purpose').notNull(),
    challengeHash: text('challenge_hash').notNull(),
    challenge: text('challenge').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    consumedAt: timestamp('consumed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('auth_challenge_hash_unique').on(table.challengeHash),
    index('auth_challenge_expiry_idx').on(table.expiresAt),
    check(
      'auth_challenge_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
  ],
);

export const journalDays = journalSchema.table(
  'journal_day',
  {
    id: uuid('id').primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    journalDate: date('journal_date', { mode: 'string' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('journal_day_user_date_unique').on(
      table.userId,
      table.journalDate,
    ),
    check(
      'journal_day_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
  ],
);

export const contributions = journalSchema.table(
  'contribution',
  {
    id: uuid('id').primaryKey(),
    journalDayId: uuid('journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    sourceType: contributionSourceType('source_type').notNull(),
    capturedAt: timestamp('captured_at', { withTimezone: true }).notNull(),
    capturedTimezone: text('captured_timezone').notNull(),
    journalTimezone: text('journal_timezone').notNull(),
    journalDateAssignment: journalDateAssignment(
      'journal_date_assignment',
    ).notNull(),
    elicitingNudgeId: uuid('eliciting_nudge_id'),
    currentRevisionId: uuid('current_revision_id'),
    currentRevision: integer('current_revision').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: uuid('deleted_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    restoredAt: timestamp('restored_at', { withTimezone: true }),
    restoredBy: uuid('restored_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('contribution_journal_day_created_idx').on(
      table.journalDayId,
      table.createdAt,
      table.id,
    ),
    index('contribution_active_day_idx')
      .on(table.journalDayId, table.id)
      .where(sql`${table.deletedAt} is null`),
    check(
      'contribution_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'contribution_current_revision_consistent',
      sql`(${table.currentRevision} = 0 and ${table.currentRevisionId} is null) or (${table.currentRevision} > 0 and ${table.currentRevisionId} is not null)`,
    ),
    check(
      'contribution_nudge_provenance',
      sql`(${table.sourceType} = 'nudge_response' and ${table.elicitingNudgeId} is not null) or (${table.sourceType} <> 'nudge_response' and ${table.elicitingNudgeId} is null)`,
    ),
    check(
      'contribution_captured_timezone_not_blank',
      sql`length(${table.capturedTimezone}) > 0`,
    ),
    check(
      'contribution_journal_timezone_not_blank',
      sql`length(${table.journalTimezone}) > 0`,
    ),
    check(
      'contribution_deletion_consistent',
      sql`(${table.deletedAt} is null and ${table.deletedBy} is null) or (${table.deletedAt} is not null and ${table.deletedBy} is not null)`,
    ),
  ],
);

export const contributionRevisions = journalSchema.table(
  'contribution_revision',
  {
    id: uuid('id').primaryKey(),
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    authority: contributionAuthority('authority').notNull(),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    contentHash: text('content_hash').notNull(),
    editReason: text('edit_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('contribution_revision_number_unique').on(
      table.contributionId,
      table.revision,
    ),
    index('contribution_revision_history_idx').on(
      table.contributionId,
      table.revision,
    ),
    check(
      'contribution_revision_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('contribution_revision_number_positive', sql`${table.revision} > 0`),
    check(
      'contribution_revision_text_not_empty',
      sql`length(${table.text}) > 0`,
    ),
    check(
      'contribution_revision_content_hash_sha256',
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'contribution_revision_edit_reason_not_blank',
      sql`${table.editReason} is null or length(btrim(${table.editReason})) > 0`,
    ),
  ],
);

export const processorRequirementMode = pgEnum('processor_requirement_mode', [
  'optional',
  'required',
]);

export const queueConfigurations = journalSchema.table(
  'queue_configuration',
  {
    name: text('name').primaryKey(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    retryLimit: integer('retry_limit').notNull(),
    retryDelaySeconds: integer('retry_delay_seconds').notNull(),
    retryBackoff: boolean('retry_backoff').notNull(),
    expireInSeconds: integer('expire_in_seconds').notNull(),
    retentionSeconds: integer('retention_seconds').notNull(),
    deadLetterQueue: text('dead_letter_queue'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.deadLetterQueue],
      foreignColumns: [table.name],
      name: 'queue_configuration_dead_letter_queue_fk',
    })
      .onDelete('restrict')
      .onUpdate('cascade'),
    check('queue_configuration_name_not_blank', sql`length(${table.name}) > 0`),
    check(
      'queue_configuration_payload_schema_version_positive',
      sql`${table.payloadSchemaVersion} > 0`,
    ),
    check(
      'queue_configuration_retry_limit_valid',
      sql`${table.retryLimit} >= 0`,
    ),
    check(
      'queue_configuration_retry_delay_valid',
      sql`${table.retryDelaySeconds} >= 0`,
    ),
    check(
      'queue_configuration_expiration_positive',
      sql`${table.expireInSeconds} > 0`,
    ),
    check(
      'queue_configuration_retention_valid',
      sql`${table.retentionSeconds} >= 0`,
    ),
  ],
);

export const schedules = journalSchema.table(
  'schedule',
  {
    key: text('key').primaryKey(),
    queueName: text('queue_name')
      .notNull()
      .references(() => queueConfigurations.name, {
        onDelete: 'restrict',
        onUpdate: 'cascade',
      }),
    cronExpression: text('cron_expression').notNull(),
    timeZone: text('time_zone').notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('schedule_queue_name_idx').on(table.queueName),
    check('schedule_key_not_blank', sql`length(${table.key}) > 0`),
    check('schedule_cron_not_blank', sql`length(${table.cronExpression}) > 0`),
    check('schedule_time_zone_not_blank', sql`length(${table.timeZone}) > 0`),
    check(
      'schedule_payload_schema_version_positive',
      sql`${table.payloadSchemaVersion} > 0`,
    ),
  ],
);

export const processorInstallations = journalSchema.table(
  'processor_installation',
  {
    id: uuid('id').primaryKey(),
    key: text('key').notNull(),
    displayName: text('display_name').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    requirementMode: processorRequirementMode('requirement_mode')
      .notNull()
      .default('optional'),
    builtIn: boolean('built_in').notNull().default(true),
    installedAt: timestamp('installed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_installation_key_unique').on(table.key),
    check(
      'processor_installation_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_installation_key_not_blank',
      sql`length(${table.key}) > 0`,
    ),
    check(
      'processor_installation_display_name_not_blank',
      sql`length(${table.displayName}) > 0`,
    ),
  ],
);

export const developmentFixtures = journalSchema.table(
  'development_fixture',
  {
    key: text('key').primaryKey(),
    fixtureType: text('fixture_type').notNull(),
    payloadSchemaVersion: integer('payload_schema_version').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check('development_fixture_key_not_blank', sql`length(${table.key}) > 0`),
    check(
      'development_fixture_type_not_blank',
      sql`length(${table.fixtureType}) > 0`,
    ),
    check(
      'development_fixture_payload_schema_version_positive',
      sql`${table.payloadSchemaVersion} > 0`,
    ),
  ],
);

export const auditEvents = journalSchema.table(
  'audit_event',
  {
    id: uuid('id').primaryKey(),
    action: text('action').notNull(),
    actorId: uuid('actor_id'),
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id'),
    revisionId: uuid('revision_id'),
    correlationId: uuid('correlation_id').notNull(),
    beforeHash: text('before_hash'),
    afterHash: text('after_hash'),
    metadata: jsonb('metadata')
      .$type<Readonly<Record<string, string | number | boolean | null>>>()
      .notNull()
      .default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('audit_event_occurred_at_id_idx').on(table.occurredAt, table.id),
    index('audit_event_entity_idx').on(table.entityType, table.entityId),
    check(
      'audit_event_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'audit_event_actor_id_uuid_v7',
      sql`${table.actorId} is null or substring(${table.actorId}::text from 15 for 1) = '7'`,
    ),
    check(
      'audit_event_entity_id_uuid_v7',
      sql`${table.entityId} is null or substring(${table.entityId}::text from 15 for 1) = '7'`,
    ),
    check(
      'audit_event_revision_id_uuid_v7',
      sql`${table.revisionId} is null or substring(${table.revisionId}::text from 15 for 1) = '7'`,
    ),
    check(
      'audit_event_before_hash_sha256',
      sql`${table.beforeHash} is null or ${table.beforeHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'audit_event_after_hash_sha256',
      sql`${table.afterHash} is null or ${table.afterHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check('audit_event_action_not_blank', sql`length(${table.action}) > 0`),
    check(
      'audit_event_entity_type_not_blank',
      sql`length(${table.entityType}) > 0`,
    ),
  ],
);

export const databaseSchema = {
  authChallenges,
  authenticators,
  auditEvents,
  contributionRevisions,
  contributions,
  developmentFixtures,
  journalDays,
  passwordCredentials,
  processorInstallations,
  queueConfigurations,
  recoveryCodes,
  schedules,
  sessions,
  users,
};
