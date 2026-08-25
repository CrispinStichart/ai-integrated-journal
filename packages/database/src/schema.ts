import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  customType,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgSchema,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

export const journalSchema = pgSchema('journal');

const tsvector = customType<{ data: string }>({
  dataType: () => 'tsvector',
});

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

export const recordingPersistenceState = pgEnum('recording_persistence_state', [
  'uploading',
  'prepared',
  'durable',
]);

export const transcriptionRunStatus = pgEnum('transcription_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const recordingTranscriptionState = pgEnum(
  'recording_transcription_state',
  ['not_started', 'queued', 'running', 'succeeded', 'failed'],
);

export const transcriptLayer = pgEnum('transcript_layer', [
  'raw_stt',
  'corrected',
  'cleaned',
]);

export const memoryType = pgEnum('memory_type', [
  'transcription_context',
  'known_entity',
  'alias',
  'correction_rule',
  'processor_rule',
  'known_fact',
  'application_preference',
]);

export const memoryApprovalState = pgEnum('memory_approval_state', [
  'pending',
  'approved',
  'rejected',
]);

export const memoryCreator = pgEnum('memory_creator', ['user', 'ai']);

export const feedbackTargetKind = pgEnum('feedback_target_kind', [
  'transcript_revision',
  'artifact_version',
  'processor_result',
]);

export const evidenceResolutionStatus = pgEnum('evidence_resolution_status', [
  'resolved',
  'unresolved',
  'stale',
]);

export const journalDateAssignment = pgEnum('journal_date_assignment', [
  'default',
  'user_override',
  'migration',
]);

export const requirementEvaluationState = pgEnum(
  'requirement_evaluation_state',
  [
    'not_evaluated',
    'satisfied',
    'insufficient_information',
    'pending_user_response',
    'dismissed',
    'not_applicable',
    'failed',
  ],
);

export const nudgeDigestStatus = pgEnum('nudge_digest_status', [
  'queued',
  'published',
  'deferred',
  'dismissed',
  'resolved',
]);

export const nudgeActionKind = pgEnum('nudge_action_kind', [
  'answer',
  'defer',
  'dismiss',
  'not_applicable',
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

export const journalApiIdempotency = journalSchema.table(
  'journal_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    contributionId: uuid('contribution_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('journal_api_idempotency_owner_operation_key_unique').on(
      table.ownerId,
      table.operation,
      table.idempotencyKey,
    ),
    check(
      'journal_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'journal_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'journal_api_idempotency_request_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
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

export const recordings = journalSchema.table(
  'recording',
  {
    id: uuid('id').primaryKey(),
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'restrict' }),
    mimeType: text('mime_type').notNull(),
    codec: text('codec'),
    durationMilliseconds: bigint('duration_milliseconds', { mode: 'bigint' }),
    finalByteSize: bigint('final_byte_size', { mode: 'bigint' }),
    finalSha256: text('final_sha256'),
    finalBlobKey: text('final_blob_key'),
    persistenceState: recordingPersistenceState('persistence_state')
      .notNull()
      .default('uploading'),
    transcriptionState: recordingTranscriptionState('transcription_state')
      .notNull()
      .default('not_started'),
    latestTranscriptionRunId: uuid('latest_transcription_run_id'),
    audioDeletedAt: timestamp('audio_deleted_at', { withTimezone: true }),
    audioDeletedBy: uuid('audio_deleted_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    audioRestoredAt: timestamp('audio_restored_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('recording_contribution_id_unique').on(table.contributionId),
    uniqueIndex('recording_final_blob_key_unique')
      .on(table.finalBlobKey)
      .where(sql`${table.finalBlobKey} is not null`),
    check(
      'recording_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('recording_mime_type_not_blank', sql`length(${table.mimeType}) > 0`),
    check(
      'recording_duration_nonnegative',
      sql`${table.durationMilliseconds} is null or ${table.durationMilliseconds} >= 0`,
    ),
    check(
      'recording_final_size_nonnegative',
      sql`${table.finalByteSize} is null or ${table.finalByteSize} >= 0`,
    ),
    check(
      'recording_final_sha256_valid',
      sql`${table.finalSha256} is null or ${table.finalSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'recording_final_fields_consistent',
      sql`(${table.persistenceState} = 'uploading' and ${table.finalByteSize} is null and ${table.finalSha256} is null and ${table.finalBlobKey} is null) or (${table.persistenceState} in ('prepared', 'durable') and ${table.finalByteSize} is not null and ${table.finalSha256} is not null and ${table.finalBlobKey} is not null)`,
    ),
    check(
      'recording_transcription_state_consistent',
      sql`(${table.transcriptionState} = 'not_started' and ${table.latestTranscriptionRunId} is null) or (${table.transcriptionState} <> 'not_started' and ${table.latestTranscriptionRunId} is not null)`,
    ),
    check(
      'recording_audio_deletion_consistent',
      sql`(${table.audioDeletedAt} is null and ${table.audioDeletedBy} is null) or (${table.audioDeletedAt} is not null and ${table.audioDeletedBy} is not null)`,
    ),
  ],
);

export const transcriptionRuns = journalSchema.table(
  'transcription_run',
  {
    id: uuid('id').primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'restrict' }),
    predecessorRunId: uuid('predecessor_run_id'),
    attempt: integer('attempt').notNull(),
    executionCount: integer('execution_count').notNull().default(0),
    status: transcriptionRunStatus('status').notNull().default('queued'),
    inputAudioSha256: text('input_audio_sha256').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    requestedContext: jsonb('requested_context')
      .$type<
        readonly Readonly<{
          text: string;
          purpose: string;
          version?: string;
          memoryId?: string;
          memoryRevisionId?: string;
        }>[]
      >()
      .notNull()
      .default([]),
    effectiveContext: jsonb('effective_context').$type<
      readonly Readonly<{
        text: string;
        purpose: string;
        version?: string;
        memoryId?: string;
        memoryRevisionId?: string;
      }>[]
    >(),
    requestedConfiguration: jsonb('requested_configuration')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    provider: jsonb('provider').$type<Readonly<Record<string, unknown>>>(),
    model: jsonb('model').$type<Readonly<Record<string, unknown>>>(),
    effectiveConfiguration: jsonb('effective_configuration').$type<
      Readonly<Record<string, unknown>>
    >(),
    processingTimeMilliseconds: bigint('processing_time_milliseconds', {
      mode: 'bigint',
    }),
    language: jsonb('language').$type<Readonly<Record<string, unknown>>>(),
    timingAvailability: jsonb('timing_availability').$type<
      Readonly<Record<string, unknown>>
    >(),
    rawResponseId: uuid('raw_response_id'),
    rawResponseBlobKey: text('raw_response_blob_key'),
    rawResponseMediaType: text('raw_response_media_type'),
    rawResponseByteSize: bigint('raw_response_byte_size', { mode: 'bigint' }),
    rawResponseSha256: text('raw_response_sha256'),
    rawResponseProviderRequestId: text('raw_response_provider_request_id'),
    rawResponseRetention: text('raw_response_retention'),
    rawResponseExpiresAt: timestamp('raw_response_expires_at', {
      withTimezone: true,
    }),
    errorCode: text('error_code'),
    errorRetryable: boolean('error_retryable'),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcription_run_recording_attempt_unique').on(
      table.recordingId,
      table.attempt,
    ),
    index('transcription_run_recording_status_idx').on(
      table.recordingId,
      table.status,
    ),
    uniqueIndex('transcription_run_raw_response_id_unique')
      .on(table.rawResponseId)
      .where(sql`${table.rawResponseId} is not null`),
    uniqueIndex('transcription_run_raw_response_blob_key_unique')
      .on(table.rawResponseBlobKey)
      .where(sql`${table.rawResponseBlobKey} is not null`),
    foreignKey({
      columns: [table.predecessorRunId],
      foreignColumns: [table.id],
      name: 'transcription_run_predecessor_run_id_fk',
    }).onDelete('restrict'),
    check(
      'transcription_run_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('transcription_run_attempt_positive', sql`${table.attempt} > 0`),
    check(
      'transcription_run_execution_count_nonnegative',
      sql`${table.executionCount} >= 0`,
    ),
    check(
      'transcription_run_input_audio_sha256_valid',
      sql`${table.inputAudioSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcription_run_input_fingerprint_valid',
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcription_run_raw_response_sha256_valid',
      sql`${table.rawResponseSha256} is null or ${table.rawResponseSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcription_run_error_consistent',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'transcription_run_completion_consistent',
      sql`(${table.status} in ('succeeded', 'failed', 'canceled') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'running') and ${table.completedAt} is null)`,
    ),
    check(
      'transcription_run_raw_response_consistent',
      sql`(${table.rawResponseId} is null and ${table.rawResponseBlobKey} is null and ${table.rawResponseMediaType} is null and ${table.rawResponseByteSize} is null and ${table.rawResponseSha256} is null and ${table.rawResponseRetention} is null and ${table.rawResponseExpiresAt} is null) or (${table.rawResponseId} is not null and ${table.rawResponseBlobKey} is not null and ${table.rawResponseMediaType} is not null and ${table.rawResponseByteSize} is not null and ${table.rawResponseSha256} is not null and ${table.rawResponseRetention} is not null and ${table.rawResponseExpiresAt} is not null)`,
    ),
  ],
);

export const transcripts = journalSchema.table(
  'transcript',
  {
    id: uuid('id').primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'restrict' }),
    layer: transcriptLayer('layer').notNull(),
    currentRevisionId: uuid('current_revision_id'),
    currentRevision: integer('current_revision').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_recording_layer_unique').on(
      table.recordingId,
      table.layer,
    ),
    check(
      'transcript_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'transcript_current_revision_consistent',
      sql`(${table.currentRevision} = 0 and ${table.currentRevisionId} is null) or (${table.currentRevision} > 0 and ${table.currentRevisionId} is not null)`,
    ),
  ],
);

export const transcriptRevisions = journalSchema.table(
  'transcript_revision',
  {
    id: uuid('id').primaryKey(),
    transcriptId: uuid('transcript_id')
      .notNull()
      .references(() => transcripts.id, { onDelete: 'restrict' }),
    sourceRunId: uuid('source_run_id').references(() => transcriptionRuns.id, {
      onDelete: 'restrict',
    }),
    sourceRevisionId: uuid('source_revision_id'),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
    evidenceText: text('evidence_text').notNull(),
    segments: jsonb('segments')
      .$type<readonly Readonly<Record<string, unknown>>[]>()
      .notNull(),
    language: jsonb('language')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    timingAvailability: jsonb('timing_availability')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    authority: contributionAuthority('authority').notNull(),
    authorId: uuid('author_id').references(() => users.id, {
      onDelete: 'restrict',
    }),
    editReason: text('edit_reason'),
    contentHash: text('content_hash').notNull(),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    staleReason: text('stale_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_revision_number_unique').on(
      table.transcriptId,
      table.revision,
    ),
    uniqueIndex('transcript_revision_source_run_unique')
      .on(table.sourceRunId)
      .where(sql`${table.sourceRunId} is not null`),
    index('transcript_revision_source_revision_idx').on(table.sourceRevisionId),
    index('transcript_revision_history_idx').on(
      table.transcriptId,
      table.revision,
    ),
    check(
      'transcript_revision_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('transcript_revision_number_positive', sql`${table.revision} > 0`),
    check(
      'transcript_revision_content_hash_sha256',
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcript_revision_staleness_consistent',
      sql`(${table.staleAt} is null and ${table.staleReason} is null) or (${table.staleAt} is not null and ${table.staleReason} is not null)`,
    ),
    check(
      'transcript_revision_source_exactly_one',
      sql`num_nonnulls(${table.sourceRunId}, ${table.sourceRevisionId}) = 1`,
    ),
    check(
      'transcript_revision_authority_consistent',
      sql`(${table.authority} = 'manual' and ${table.authorId} is not null) or (${table.authority} = 'generated' and ${table.authorId} is null)`,
    ),
    foreignKey({
      columns: [table.sourceRevisionId],
      foreignColumns: [table.id],
      name: 'transcript_revision_source_revision_id_fk',
    }).onDelete('restrict'),
  ],
);

export const transcriptSegments = journalSchema.table(
  'transcript_segment',
  {
    id: uuid('id').primaryKey(),
    transcriptRevisionId: uuid('transcript_revision_id')
      .notNull()
      .references(() => transcriptRevisions.id, { onDelete: 'restrict' }),
    sourceSegmentId: uuid('source_segment_id'),
    ordinal: integer('ordinal').notNull(),
    startUtf16: integer('start_utf16').notNull(),
    endUtf16: integer('end_utf16').notNull(),
    startMs: bigint('start_ms', { mode: 'bigint' }),
    endMs: bigint('end_ms', { mode: 'bigint' }),
    quote: text('quote').notNull(),
    quoteHash: text('quote_hash').notNull(),
    providerMetadata:
      jsonb('provider_metadata').$type<Readonly<Record<string, unknown>>>(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_segment_revision_ordinal_unique').on(
      table.transcriptRevisionId,
      table.ordinal,
    ),
    uniqueIndex('transcript_segment_revision_id_unique').on(
      table.transcriptRevisionId,
      table.id,
    ),
    index('transcript_segment_source_segment_idx').on(table.sourceSegmentId),
    foreignKey({
      columns: [table.sourceSegmentId],
      foreignColumns: [table.id],
      name: 'transcript_segment_source_segment_id_fk',
    }).onDelete('restrict'),
    check(
      'transcript_segment_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('transcript_segment_ordinal_nonnegative', sql`${table.ordinal} >= 0`),
    check(
      'transcript_segment_text_range_valid',
      sql`${table.startUtf16} >= 0 and ${table.startUtf16} < ${table.endUtf16}`,
    ),
    check(
      'transcript_segment_audio_range_valid',
      sql`(${table.startMs} is null and ${table.endMs} is null) or (${table.startMs} >= 0 and ${table.startMs} < ${table.endMs})`,
    ),
    check(
      'transcript_segment_quote_not_empty',
      sql`length(${table.quote}) > 0`,
    ),
    check(
      'transcript_segment_quote_hash_sha256',
      sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const transcriptEvidenceSpans = journalSchema.table(
  'transcript_evidence_span',
  {
    id: uuid('id').primaryKey(),
    dependentTranscriptRevisionId: uuid('dependent_transcript_revision_id')
      .notNull()
      .references(() => transcriptRevisions.id, { onDelete: 'restrict' }),
    sourceTranscriptRevisionId: uuid('source_transcript_revision_id')
      .notNull()
      .references(() => transcriptRevisions.id, { onDelete: 'restrict' }),
    sourceSegmentId: uuid('source_segment_id'),
    normalization: text('normalization').notNull().default('NFC_LF_V1'),
    offsetUnit: text('offset_unit').notNull().default('utf16_code_unit'),
    startUtf16: integer('start_utf16').notNull(),
    endUtf16: integer('end_utf16').notNull(),
    startMs: bigint('start_ms', { mode: 'bigint' }),
    endMs: bigint('end_ms', { mode: 'bigint' }),
    quote: text('quote').notNull(),
    quoteHash: text('quote_hash').notNull(),
    resolutionStatus: evidenceResolutionStatus('resolution_status')
      .notNull()
      .default('resolved'),
    unresolvedReason: text('unresolved_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('transcript_evidence_span_dependent_idx').on(
      table.dependentTranscriptRevisionId,
    ),
    index('transcript_evidence_span_source_idx').on(
      table.sourceTranscriptRevisionId,
    ),
    foreignKey({
      columns: [table.sourceTranscriptRevisionId, table.sourceSegmentId],
      foreignColumns: [
        transcriptSegments.transcriptRevisionId,
        transcriptSegments.id,
      ],
      name: 'transcript_evidence_span_source_segment_fk',
    }).onDelete('restrict'),
    check(
      'transcript_evidence_span_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'transcript_evidence_span_coordinate_contract',
      sql`${table.normalization} = 'NFC_LF_V1' and ${table.offsetUnit} = 'utf16_code_unit'`,
    ),
    check(
      'transcript_evidence_span_text_range_valid',
      sql`${table.startUtf16} >= 0 and ${table.startUtf16} < ${table.endUtf16}`,
    ),
    check(
      'transcript_evidence_span_audio_range_valid',
      sql`(${table.startMs} is null and ${table.endMs} is null) or (${table.startMs} >= 0 and ${table.startMs} < ${table.endMs})`,
    ),
    check(
      'transcript_evidence_span_quote_not_empty',
      sql`length(${table.quote}) > 0`,
    ),
    check(
      'transcript_evidence_span_quote_hash_sha256',
      sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcript_evidence_span_resolution_consistent',
      sql`(${table.resolutionStatus} = 'resolved' and ${table.unresolvedReason} is null) or (${table.resolutionStatus} <> 'resolved' and ${table.unresolvedReason} is not null)`,
    ),
    check(
      'transcript_evidence_span_reason_code_valid',
      sql`${table.unresolvedReason} is null or ${table.unresolvedReason} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  ],
);

export const transcriptCleanupRuns = journalSchema.table(
  'transcript_cleanup_run',
  {
    id: uuid('id').primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'restrict' }),
    sourceCorrectedRevisionId: uuid('source_corrected_revision_id')
      .notNull()
      .references(() => transcriptRevisions.id, { onDelete: 'restrict' }),
    outputCleanedRevisionId: uuid('output_cleaned_revision_id').references(
      () => transcriptRevisions.id,
      { onDelete: 'restrict' },
    ),
    predecessorRunId: uuid('predecessor_run_id'),
    attempt: integer('attempt').notNull(),
    executionCount: integer('execution_count').notNull().default(0),
    status: transcriptionRunStatus('status').notNull().default('queued'),
    inputFingerprint: text('input_fingerprint').notNull(),
    promptId: text('prompt_id').notNull(),
    promptVersion: text('prompt_version').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    requestedConfiguration: jsonb('requested_configuration')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    provider: jsonb('provider').$type<Readonly<Record<string, unknown>>>(),
    model: jsonb('model').$type<Readonly<Record<string, unknown>>>(),
    effectiveConfiguration: jsonb('effective_configuration').$type<
      Readonly<Record<string, unknown>>
    >(),
    processingTimeMilliseconds: bigint('processing_time_milliseconds', {
      mode: 'bigint',
    }),
    usage: jsonb('usage').$type<Readonly<Record<string, unknown>>>(),
    rawResponseId: uuid('raw_response_id'),
    rawResponseBlobKey: text('raw_response_blob_key'),
    rawResponseMediaType: text('raw_response_media_type'),
    rawResponseByteSize: bigint('raw_response_byte_size', { mode: 'bigint' }),
    rawResponseSha256: text('raw_response_sha256'),
    rawResponseProviderRequestId: text('raw_response_provider_request_id'),
    rawResponseRetention: text('raw_response_retention'),
    rawResponseExpiresAt: timestamp('raw_response_expires_at', {
      withTimezone: true,
    }),
    errorCode: text('error_code'),
    errorRetryable: boolean('error_retryable'),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    staleReason: text('stale_reason'),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_cleanup_run_revision_attempt_unique').on(
      table.sourceCorrectedRevisionId,
      table.attempt,
    ),
    uniqueIndex('transcript_cleanup_run_output_revision_unique')
      .on(table.outputCleanedRevisionId)
      .where(sql`${table.outputCleanedRevisionId} is not null`),
    uniqueIndex('transcript_cleanup_run_raw_response_id_unique')
      .on(table.rawResponseId)
      .where(sql`${table.rawResponseId} is not null`),
    uniqueIndex('transcript_cleanup_run_raw_response_blob_key_unique')
      .on(table.rawResponseBlobKey)
      .where(sql`${table.rawResponseBlobKey} is not null`),
    index('transcript_cleanup_run_recording_status_idx').on(
      table.recordingId,
      table.status,
    ),
    foreignKey({
      columns: [table.predecessorRunId],
      foreignColumns: [table.id],
      name: 'transcript_cleanup_run_predecessor_run_id_fk',
    }).onDelete('restrict'),
    check(
      'transcript_cleanup_run_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('transcript_cleanup_run_attempt_positive', sql`${table.attempt} > 0`),
    check(
      'transcript_cleanup_run_execution_count_nonnegative',
      sql`${table.executionCount} >= 0`,
    ),
    check(
      'transcript_cleanup_run_input_fingerprint_valid',
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcript_cleanup_run_prompt_hash_valid',
      sql`${table.promptTemplateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcript_cleanup_run_prompt_fields_not_blank',
      sql`length(${table.promptId}) > 0 and length(${table.promptVersion}) > 0`,
    ),
    check(
      'transcript_cleanup_run_raw_response_sha256_valid',
      sql`${table.rawResponseSha256} is null or ${table.rawResponseSha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'transcript_cleanup_run_error_consistent',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'transcript_cleanup_run_completion_consistent',
      sql`(${table.status} in ('succeeded', 'failed', 'canceled') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'running') and ${table.completedAt} is null)`,
    ),
    check(
      'transcript_cleanup_run_output_consistent',
      sql`(${table.status} = 'succeeded' and ${table.outputCleanedRevisionId} is not null) or (${table.status} <> 'succeeded' and ${table.outputCleanedRevisionId} is null)`,
    ),
    check(
      'transcript_cleanup_run_staleness_consistent',
      sql`(${table.staleAt} is null and ${table.staleReason} is null) or (${table.status} = 'succeeded' and ${table.staleAt} is not null and ${table.staleReason} is not null)`,
    ),
    check(
      'transcript_cleanup_run_raw_response_consistent',
      sql`(${table.rawResponseId} is null and ${table.rawResponseBlobKey} is null and ${table.rawResponseMediaType} is null and ${table.rawResponseByteSize} is null and ${table.rawResponseSha256} is null and ${table.rawResponseRetention} is null and ${table.rawResponseExpiresAt} is null) or (${table.rawResponseId} is not null and ${table.rawResponseBlobKey} is not null and ${table.rawResponseMediaType} is not null and ${table.rawResponseByteSize} is not null and ${table.rawResponseSha256} is not null and ${table.rawResponseRetention} is not null and ${table.rawResponseExpiresAt} is not null)`,
    ),
  ],
);

export const recordingUploads = journalSchema.table(
  'recording_upload',
  {
    id: uuid('id').primaryKey(),
    recordingId: uuid('recording_id')
      .notNull()
      .references(() => recordings.id, { onDelete: 'restrict' }),
    manifestVersion: integer('manifest_version'),
    manifestChunkCount: bigint('manifest_chunk_count', { mode: 'bigint' }),
    manifestTotalBytes: bigint('manifest_total_bytes', { mode: 'bigint' }),
    manifestSha256: text('manifest_sha256'),
    manifestFingerprint: text('manifest_fingerprint'),
    lastActivityAt: timestamp('last_activity_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('recording_upload_recording_id_unique').on(table.recordingId),
    check(
      'recording_upload_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'recording_upload_manifest_counts_nonnegative',
      sql`(${table.manifestChunkCount} is null or ${table.manifestChunkCount} >= 0) and (${table.manifestTotalBytes} is null or ${table.manifestTotalBytes} >= 0)`,
    ),
    check(
      'recording_upload_manifest_hashes_valid',
      sql`(${table.manifestSha256} is null or ${table.manifestSha256} ~ '^[0-9a-f]{64}$') and (${table.manifestFingerprint} is null or ${table.manifestFingerprint} ~ '^[0-9a-f]{64}$')`,
    ),
    check(
      'recording_upload_manifest_fields_consistent',
      sql`(${table.manifestVersion} is null and ${table.manifestChunkCount} is null and ${table.manifestTotalBytes} is null and ${table.manifestSha256} is null and ${table.manifestFingerprint} is null) or (${table.manifestVersion} is not null and ${table.manifestChunkCount} is not null and ${table.manifestTotalBytes} is not null and ${table.manifestSha256} is not null and ${table.manifestFingerprint} is not null)`,
    ),
  ],
);

export const recordingChunks = journalSchema.table(
  'recording_chunk',
  {
    uploadId: uuid('upload_id')
      .notNull()
      .references(() => recordingUploads.id, { onDelete: 'restrict' }),
    chunkIndex: integer('chunk_index').notNull(),
    byteSize: bigint('byte_size', { mode: 'bigint' }).notNull(),
    sha256: text('sha256').notNull(),
    stagingBlobKey: text('staging_blob_key').notNull(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('recording_chunk_upload_index_unique').on(
      table.uploadId,
      table.chunkIndex,
    ),
    uniqueIndex('recording_chunk_staging_blob_key_unique').on(
      table.stagingBlobKey,
    ),
    index('recording_chunk_manifest_order_idx').on(
      table.uploadId,
      table.chunkIndex,
    ),
    check('recording_chunk_index_nonnegative', sql`${table.chunkIndex} >= 0`),
    check(
      'recording_chunk_byte_size_bounded',
      sql`${table.byteSize} >= 0 and ${table.byteSize} <= 8388608`,
    ),
    check(
      'recording_chunk_sha256_valid',
      sql`${table.sha256} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'recording_chunk_staging_key_not_blank',
      sql`length(${table.stagingBlobKey}) > 0`,
    ),
  ],
);

export const recordingApiIdempotency = journalSchema.table(
  'recording_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    recordingId: uuid('recording_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('recording_api_idempotency_owner_operation_key_unique').on(
      table.ownerId,
      table.operation,
      table.idempotencyKey,
    ),
    check(
      'recording_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'recording_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'recording_api_idempotency_request_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const processorRequirementMode = pgEnum('processor_requirement_mode', [
  'optional',
  'required',
]);

export const processorRunStatus = pgEnum('processor_run_status', [
  'queued',
  'running',
  'succeeded',
  'failed',
  'canceled',
]);

export const processorCompleteness = pgEnum('processor_completeness', [
  'complete',
  'partial',
]);

export const processorInputKind = pgEnum('processor_input_kind', [
  'typed_text',
  'corrected_transcript',
  'cleaned_transcript',
  'processor_result',
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
    purpose: text('purpose').notNull().default('Journal processor'),
    enabled: boolean('enabled').notNull().default(false),
    requirementMode: processorRequirementMode('requirement_mode')
      .notNull()
      .default('optional'),
    builtIn: boolean('built_in').notNull().default(true),
    configRevision: integer('config_revision').notNull().default(1),
    currentVersionId: uuid('current_version_id'),
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
    check(
      'processor_installation_purpose_not_blank',
      sql`length(${table.purpose}) > 0`,
    ),
    check(
      'processor_installation_config_revision_positive',
      sql`${table.configRevision} > 0`,
    ),
  ],
);

export const processorVersions = journalSchema.table(
  'processor_version',
  {
    id: uuid('id').primaryKey(),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    semanticVersion: text('semantic_version').notNull(),
    definition: jsonb('definition')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    instructionHash: text('instruction_hash').notNull(),
    outputSchemaHash: text('output_schema_hash').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    createdBy: uuid('created_by').references(() => users.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_version_revision_unique').on(
      table.processorId,
      table.revision,
    ),
    uniqueIndex('processor_version_semantic_unique').on(
      table.processorId,
      table.semanticVersion,
    ),
    index('processor_version_processor_created_idx').on(
      table.processorId,
      table.createdAt,
      table.id,
    ),
    check(
      'processor_version_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('processor_version_revision_positive', sql`${table.revision} > 0`),
    check(
      'processor_version_semantic_valid',
      sql`${table.semanticVersion} ~ '^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$'`,
    ),
    check(
      'processor_version_instruction_hash_sha256',
      sql`${table.instructionHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_version_output_schema_hash_sha256',
      sql`${table.outputSchemaHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_version_prompt_template_hash_sha256',
      sql`${table.promptTemplateHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const processorVersionDependencies = journalSchema.table(
  'processor_version_dependency',
  {
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    upstreamVersionId: uuid('upstream_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    outputSelector: text('output_selector').notNull(),
    acceptPartial: boolean('accept_partial').notNull().default(false),
  },
  (table) => [
    primaryKey({
      name: 'processor_version_dependency_pk',
      columns: [
        table.processorVersionId,
        table.upstreamVersionId,
        table.outputSelector,
      ],
    }),
    index('processor_version_dependency_upstream_idx').on(
      table.upstreamVersionId,
    ),
    check(
      'processor_version_dependency_not_self',
      sql`${table.processorVersionId} <> ${table.upstreamVersionId}`,
    ),
    check(
      'processor_version_dependency_selector_not_blank',
      sql`length(${table.outputSelector}) > 0`,
    ),
  ],
);

export const processorRuns = journalSchema.table(
  'processor_run',
  {
    id: uuid('id').primaryKey(),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    targetScope: text('target_scope').notNull(),
    targetJournalDayId: uuid('target_journal_day_id').references(
      () => journalDays.id,
      { onDelete: 'restrict' },
    ),
    targetContributionId: uuid('target_contribution_id').references(
      () => contributions.id,
      { onDelete: 'restrict' },
    ),
    predecessorRunId: uuid('predecessor_run_id'),
    attempt: integer('attempt').notNull(),
    executionCount: integer('execution_count').notNull().default(0),
    status: processorRunStatus('status').notNull().default('queued'),
    inputCompleteness: processorCompleteness('input_completeness').notNull(),
    inputFingerprint: text('input_fingerprint').notNull(),
    promptAssemblyVersion: text('prompt_assembly_version').notNull(),
    promptTemplateHash: text('prompt_template_hash').notNull(),
    requestedConfiguration: jsonb('requested_configuration')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull()
      .default({}),
    provider: jsonb('provider').$type<Readonly<Record<string, unknown>>>(),
    model: jsonb('model').$type<Readonly<Record<string, unknown>>>(),
    effectiveConfiguration: jsonb('effective_configuration').$type<
      Readonly<Record<string, unknown>>
    >(),
    effectiveMessagesHash: text('effective_messages_hash'),
    usage: jsonb('usage').$type<Readonly<Record<string, unknown>>>(),
    processingTimeMilliseconds: bigint('processing_time_milliseconds', {
      mode: 'bigint',
    }),
    rawResponseId: uuid('raw_response_id'),
    rawResponseBlobKey: text('raw_response_blob_key'),
    rawResponseMediaType: text('raw_response_media_type'),
    rawResponseByteSize: bigint('raw_response_byte_size', { mode: 'bigint' }),
    rawResponseSha256: text('raw_response_sha256'),
    rawResponseProviderRequestId: text('raw_response_provider_request_id'),
    rawResponseRetention: text('raw_response_retention'),
    rawResponseExpiresAt: timestamp('raw_response_expires_at', {
      withTimezone: true,
    }),
    outputResultId: uuid('output_result_id'),
    errorCode: text('error_code'),
    errorRetryable: boolean('error_retryable'),
    queuedAt: timestamp('queued_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_run_day_attempt_unique')
      .on(table.processorVersionId, table.targetJournalDayId, table.attempt)
      .where(sql`${table.targetScope} = 'journal_day'`),
    uniqueIndex('processor_run_contribution_attempt_unique')
      .on(table.processorVersionId, table.targetContributionId, table.attempt)
      .where(sql`${table.targetScope} = 'contribution'`),
    index('processor_run_target_status_idx').on(
      table.targetJournalDayId,
      table.status,
    ),
    foreignKey({
      columns: [table.predecessorRunId],
      foreignColumns: [table.id],
      name: 'processor_run_predecessor_fk',
    }).onDelete('restrict'),
    check(
      'processor_run_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('processor_run_attempt_positive', sql`${table.attempt} > 0`),
    check(
      'processor_run_execution_nonnegative',
      sql`${table.executionCount} >= 0`,
    ),
    check(
      'processor_run_scope_valid',
      sql`${table.targetScope} in ('contribution', 'journal_day')`,
    ),
    check(
      'processor_run_target_consistent',
      sql`(${table.targetScope} = 'journal_day' and ${table.targetJournalDayId} is not null and ${table.targetContributionId} is null) or (${table.targetScope} = 'contribution' and ${table.targetJournalDayId} is not null and ${table.targetContributionId} is not null)`,
    ),
    check(
      'processor_run_input_hash_sha256',
      sql`${table.inputFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_run_prompt_hash_sha256',
      sql`${table.promptTemplateHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_run_effective_messages_hash_sha256',
      sql`${table.effectiveMessagesHash} is null or ${table.effectiveMessagesHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_run_error_consistent',
      sql`(${table.status} = 'failed' and ${table.errorCode} is not null and ${table.errorRetryable} is not null) or (${table.status} <> 'failed' and ${table.errorCode} is null and ${table.errorRetryable} is null)`,
    ),
    check(
      'processor_run_completion_consistent',
      sql`(${table.status} in ('succeeded', 'failed', 'canceled') and ${table.completedAt} is not null) or (${table.status} in ('queued', 'running') and ${table.completedAt} is null)`,
    ),
    check(
      'processor_run_output_consistent',
      sql`(${table.status} = 'succeeded' and ${table.outputResultId} is not null) or (${table.status} <> 'succeeded' and ${table.outputResultId} is null)`,
    ),
  ],
);

export const processorResults = journalSchema.table(
  'processor_result',
  {
    id: uuid('id').primaryKey(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    targetJournalDayId: uuid('target_journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    targetContributionId: uuid('target_contribution_id').references(
      () => contributions.id,
      { onDelete: 'restrict' },
    ),
    kind: text('kind').notNull(),
    lifecycle: text('lifecycle').notNull().default('active'),
    completeness: processorCompleteness('completeness').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    authority: contributionAuthority('authority')
      .notNull()
      .default('generated'),
    manuallyModified: boolean('manually_modified').notNull().default(false),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    staleReason: text('stale_reason'),
    supersededById: uuid('superseded_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_result_run_unique').on(table.runId),
    index('processor_result_target_idx').on(
      table.targetJournalDayId,
      table.processorVersionId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.supersededById],
      foreignColumns: [table.id],
      name: 'processor_result_superseded_by_fk',
    }).onDelete('restrict'),
    check(
      'processor_result_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_result_kind_valid',
      sql`${table.kind} in ('source_transform', 'observation', 'interpretation', 'other')`,
    ),
    check(
      'processor_result_lifecycle_valid',
      sql`${table.lifecycle} in ('active', 'superseded')`,
    ),
    check(
      'processor_result_generated_only',
      sql`${table.authority} = 'generated' and ${table.manuallyModified} = false`,
    ),
    check(
      'processor_result_staleness_consistent',
      sql`(${table.staleAt} is null and ${table.staleReason} is null) or (${table.staleAt} is not null and ${table.staleReason} is not null)`,
    ),
  ],
);

/** Stable logical artifact identity; immutable generated history lives below. */
export const processorArtifacts = journalSchema.table(
  'processor_artifact',
  {
    id: uuid('id').primaryKey(),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    targetJournalDayId: uuid('target_journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    targetContributionId: uuid('target_contribution_id').references(
      () => contributions.id,
      { onDelete: 'restrict' },
    ),
    logicalKey: text('logical_key').notNull(),
    kind: text('kind').notNull(),
    authority: contributionAuthority('authority')
      .notNull()
      .default('generated'),
    revision: integer('revision').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_artifact_day_logical_key_unique')
      .on(table.processorId, table.targetJournalDayId, table.logicalKey)
      .where(sql`${table.targetContributionId} is null`),
    uniqueIndex('processor_artifact_contribution_logical_key_unique')
      .on(table.processorId, table.targetContributionId, table.logicalKey)
      .where(sql`${table.targetContributionId} is not null`),
    index('processor_artifact_active_target_idx').on(
      table.targetJournalDayId,
      table.processorId,
      table.active,
    ),
    check(
      'processor_artifact_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_artifact_logical_key_valid',
      sql`length(${table.logicalKey}) > 0 and length(${table.logicalKey}) <= 256`,
    ),
    check(
      'processor_artifact_kind_valid',
      sql`${table.kind} in ('source_transform', 'observation', 'interpretation', 'other')`,
    ),
    check(
      'processor_artifact_revision_nonnegative',
      sql`${table.revision} >= 0`,
    ),
  ],
);

/** Immutable payload revisions for one stable logical processor artifact. */
export const processorArtifactVersions = journalSchema.table(
  'processor_artifact_version',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => processorArtifacts.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    sourceResultId: uuid('source_result_id')
      .notNull()
      .references(() => processorResults.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    payloadHash: text('payload_hash').notNull(),
    lifecycle: text('lifecycle').notNull().default('active'),
    reconciliationOutcome: text('reconciliation_outcome').notNull(),
    supersedesVersionId: uuid('supersedes_version_id'),
    supersededByVersionId: uuid('superseded_by_version_id'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('processor_artifact_version_revision_unique').on(
      table.artifactId,
      table.revision,
    ),
    uniqueIndex('processor_artifact_version_run_artifact_unique').on(
      table.runId,
      table.artifactId,
    ),
    uniqueIndex('processor_artifact_version_one_active_unique')
      .on(table.artifactId)
      .where(sql`${table.lifecycle} = 'active'`),
    index('processor_artifact_version_source_result_idx').on(
      table.sourceResultId,
    ),
    foreignKey({
      columns: [table.supersedesVersionId],
      foreignColumns: [table.id],
      name: 'processor_artifact_version_supersedes_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersededByVersionId],
      foreignColumns: [table.id],
      name: 'processor_artifact_version_superseded_by_fk',
    }).onDelete('restrict'),
    check(
      'processor_artifact_version_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_artifact_version_revision_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'processor_artifact_version_payload_hash_sha256',
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_artifact_version_lifecycle_valid',
      sql`${table.lifecycle} in ('active', 'superseded')`,
    ),
    check(
      'processor_artifact_version_outcome_valid',
      sql`${table.reconciliationOutcome} in ('create', 'update', 'supersede')`,
    ),
    check(
      'processor_artifact_version_supersession_consistent',
      sql`(${table.lifecycle} = 'active' and ${table.supersededByVersionId} is null and ${table.supersededAt} is null) or (${table.lifecycle} = 'superseded' and ${table.supersededAt} is not null)`,
    ),
  ],
);

/** Immutable user-authored overlays and tombstones for a stable artifact. */
export const processorArtifactManualRevisions = journalSchema.table(
  'processor_artifact_manual_revision',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => processorArtifacts.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    operation: text('operation').notNull(),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    payloadHash: text('payload_hash').notNull(),
    overrides: jsonb('overrides')
      .$type<readonly Readonly<{ path: string; value: unknown }>[]>()
      .notNull()
      .default([]),
    authorId: uuid('author_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    editGroupId: uuid('edit_group_id').notNull(),
    reason: text('reason'),
    active: boolean('active').notNull().default(true),
    supersedesRevisionId: uuid('supersedes_revision_id'),
    supersededByRevisionId: uuid('superseded_by_revision_id'),
    staleAt: timestamp('stale_at', { withTimezone: true }),
    staleReason: text('stale_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    supersededAt: timestamp('superseded_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('processor_artifact_manual_revision_number_unique').on(
      table.artifactId,
      table.revision,
    ),
    uniqueIndex('processor_artifact_manual_revision_one_active_unique')
      .on(table.artifactId)
      .where(sql`${table.active} = true`),
    index('processor_artifact_manual_edit_group_idx').on(table.editGroupId),
    foreignKey({
      columns: [table.supersedesRevisionId],
      foreignColumns: [table.id],
      name: 'processor_artifact_manual_supersedes_fk',
    }).onDelete('restrict'),
    foreignKey({
      columns: [table.supersededByRevisionId],
      foreignColumns: [table.id],
      name: 'processor_artifact_manual_superseded_by_fk',
    }).onDelete('restrict'),
    check(
      'processor_artifact_manual_revision_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_artifact_manual_revision_number_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'processor_artifact_manual_operation_valid',
      sql`${table.operation} in ('add', 'confirm', 'correct', 'delete', 'merge_result', 'merge_source', 'pin', 'split_result', 'split_source')`,
    ),
    check(
      'processor_artifact_manual_payload_hash_sha256',
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_artifact_manual_lifecycle_consistent',
      sql`(${table.active} = true and ${table.supersededByRevisionId} is null and ${table.supersededAt} is null) or (${table.active} = false and ${table.supersededAt} is not null)`,
    ),
    check(
      'processor_artifact_manual_staleness_consistent',
      sql`(${table.staleAt} is null and ${table.staleReason} is null) or (${table.staleAt} is not null and ${table.staleReason} is not null)`,
    ),
  ],
);

/** Generated disagreement retained for explicit review under manual authority. */
export const processorArtifactCandidates = journalSchema.table(
  'processor_artifact_candidate',
  {
    id: uuid('id').primaryKey(),
    artifactId: uuid('artifact_id')
      .notNull()
      .references(() => processorArtifacts.id, { onDelete: 'restrict' }),
    runId: uuid('run_id')
      .notNull()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    sourceResultId: uuid('source_result_id')
      .notNull()
      .references(() => processorResults.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    conflictsWithManualRevisionId: uuid('conflicts_with_manual_revision_id')
      .notNull()
      .references(() => processorArtifactManualRevisions.id, {
        onDelete: 'restrict',
      }),
    payload: jsonb('payload')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    payloadHash: text('payload_hash').notNull(),
    status: text('status').notNull().default('reviewable'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_artifact_candidate_run_artifact_unique').on(
      table.runId,
      table.artifactId,
    ),
    uniqueIndex('processor_artifact_candidate_one_reviewable_unique')
      .on(table.artifactId)
      .where(sql`${table.status} = 'reviewable'`),
    check(
      'processor_artifact_candidate_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_artifact_candidate_payload_hash_sha256',
      sql`${table.payloadHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_artifact_candidate_status_valid',
      sql`${table.status} in ('reviewable', 'adopted', 'dismissed', 'superseded')`,
    ),
    check(
      'processor_artifact_candidate_resolution_consistent',
      sql`(${table.status} = 'reviewable' and ${table.resolvedAt} is null) or (${table.status} <> 'reviewable' and ${table.resolvedAt} is not null)`,
    ),
  ],
);

export const artifactApiIdempotency = journalSchema.table(
  'artifact_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    response: jsonb('response')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'artifact_api_idempotency_pk',
      columns: [table.ownerId, table.operation, table.idempotencyKey],
    }),
    check(
      'artifact_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'artifact_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'artifact_api_idempotency_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** One durable idempotency boundary per completed processor run. */
export const processorReconciliations = journalSchema.table(
  'processor_reconciliation',
  {
    runId: uuid('run_id')
      .primaryKey()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    sourceResultId: uuid('source_result_id')
      .notNull()
      .references(() => processorResults.id, { onDelete: 'restrict' }),
    strategy: text('strategy').notNull(),
    completeness: processorCompleteness('completeness').notNull(),
    inputHash: text('input_hash').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_reconciliation_source_result_unique').on(
      table.sourceResultId,
    ),
    check(
      'processor_reconciliation_strategy_valid',
      sql`${table.strategy} in ('replace_scope', 'logical_key', 'append_only')`,
    ),
    check(
      'processor_reconciliation_input_hash_sha256',
      sql`${table.inputHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const processorReconciliationOutcomes = journalSchema.table(
  'processor_reconciliation_outcome',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => processorReconciliations.runId, {
        onDelete: 'restrict',
      }),
    ordinal: integer('ordinal').notNull(),
    logicalKey: text('logical_key').notNull(),
    outcome: text('outcome').notNull(),
    artifactId: uuid('artifact_id').references(() => processorArtifacts.id, {
      onDelete: 'restrict',
    }),
    versionId: uuid('version_id').references(
      () => processorArtifactVersions.id,
      { onDelete: 'restrict' },
    ),
    priorVersionId: uuid('prior_version_id').references(
      () => processorArtifactVersions.id,
      { onDelete: 'restrict' },
    ),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'processor_reconciliation_outcome_pk',
      columns: [table.runId, table.ordinal],
    }),
    uniqueIndex('processor_reconciliation_outcome_run_key_unique').on(
      table.runId,
      table.logicalKey,
    ),
    check(
      'processor_reconciliation_outcome_ordinal_nonnegative',
      sql`${table.ordinal} >= 0`,
    ),
    check(
      'processor_reconciliation_outcome_key_valid',
      sql`length(${table.logicalKey}) > 0 and length(${table.logicalKey}) <= 256`,
    ),
    check(
      'processor_reconciliation_outcome_value_valid',
      sql`${table.outcome} in ('create', 'update', 'supersede', 'remove_supersede', 'unchanged')`,
    ),
    check(
      'processor_reconciliation_outcome_references_consistent',
      sql`(${table.outcome} = 'create' and ${table.artifactId} is not null and ${table.versionId} is not null and ${table.priorVersionId} is null) or (${table.outcome} in ('update', 'supersede') and ${table.artifactId} is not null and ${table.versionId} is not null and ${table.priorVersionId} is not null) or (${table.outcome} in ('remove_supersede', 'unchanged') and ${table.artifactId} is not null and ${table.versionId} is null and ${table.priorVersionId} is not null)`,
    ),
  ],
);

export const processorRunInputs = journalSchema.table(
  'processor_run_input',
  {
    runId: uuid('run_id')
      .notNull()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    label: text('label').notNull(),
    inputKind: processorInputKind('input_kind').notNull(),
    contributionRevisionId: uuid('contribution_revision_id').references(
      () => contributionRevisions.id,
      { onDelete: 'restrict' },
    ),
    transcriptRevisionId: uuid('transcript_revision_id').references(
      () => transcriptRevisions.id,
      { onDelete: 'restrict' },
    ),
    processorResultId: uuid('processor_result_id').references(
      () => processorResults.id,
      { onDelete: 'restrict' },
    ),
    outputSelector: text('output_selector'),
    includedStartUtf16: integer('included_start_utf16').notNull().default(0),
    includedEndUtf16: integer('included_end_utf16').notNull(),
    fullLengthUtf16: integer('full_length_utf16').notNull(),
    contentHash: text('content_hash').notNull(),
    temporalContext: jsonb('temporal_context')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'processor_run_input_pk',
      columns: [table.runId, table.ordinal],
    }),
    uniqueIndex('processor_run_input_label_unique').on(
      table.runId,
      table.label,
    ),
    index('processor_run_input_contribution_revision_idx').on(
      table.contributionRevisionId,
    ),
    index('processor_run_input_transcript_revision_idx').on(
      table.transcriptRevisionId,
    ),
    index('processor_run_input_processor_result_idx').on(
      table.processorResultId,
    ),
    check(
      'processor_run_input_ordinal_nonnegative',
      sql`${table.ordinal} >= 0`,
    ),
    check(
      'processor_run_input_exactly_one_source',
      sql`num_nonnulls(${table.contributionRevisionId}, ${table.transcriptRevisionId}, ${table.processorResultId}) = 1`,
    ),
    check(
      'processor_run_input_selector_consistent',
      sql`(${table.processorResultId} is not null and ${table.outputSelector} is not null and length(${table.outputSelector}) > 0) or (${table.processorResultId} is null and ${table.outputSelector} is null)`,
    ),
    check(
      'processor_run_input_range_valid',
      sql`${table.includedStartUtf16} = 0 and ${table.includedEndUtf16} >= 0 and ${table.includedEndUtf16} <= ${table.fullLengthUtf16}`,
    ),
    check(
      'processor_run_input_content_hash_sha256',
      sql`${table.contentHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

export const processorResultEvidence = journalSchema.table(
  'processor_result_evidence',
  {
    id: uuid('id').primaryKey(),
    processorResultId: uuid('processor_result_id')
      .notNull()
      .references(() => processorResults.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    sourceLabel: text('source_label').notNull(),
    contributionRevisionId: uuid('contribution_revision_id').references(
      () => contributionRevisions.id,
      { onDelete: 'restrict' },
    ),
    transcriptRevisionId: uuid('transcript_revision_id').references(
      () => transcriptRevisions.id,
      { onDelete: 'restrict' },
    ),
    normalization: text('normalization').notNull(),
    offsetUnit: text('offset_unit').notNull(),
    startUtf16: integer('start_utf16').notNull(),
    endUtf16: integer('end_utf16').notNull(),
    startMs: bigint('start_ms', { mode: 'bigint' }),
    endMs: bigint('end_ms', { mode: 'bigint' }),
    quote: text('quote').notNull(),
    quoteHash: text('quote_hash').notNull(),
    resolutionStatus: evidenceResolutionStatus('resolution_status')
      .notNull()
      .default('resolved'),
    unresolvedReason: text('unresolved_reason'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('processor_result_evidence_result_ordinal_unique').on(
      table.processorResultId,
      table.ordinal,
    ),
    index('processor_result_evidence_result_idx').on(table.processorResultId),
    index('processor_result_evidence_transcript_idx').on(
      table.transcriptRevisionId,
    ),
    check(
      'processor_result_evidence_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'processor_result_evidence_ordinal_nonnegative',
      sql`${table.ordinal} >= 0`,
    ),
    check(
      'processor_result_evidence_exactly_one_source',
      sql`num_nonnulls(${table.contributionRevisionId}, ${table.transcriptRevisionId}) = 1`,
    ),
    check(
      'processor_result_evidence_coordinate_contract',
      sql`${table.normalization} = 'NFC_LF_V1' and ${table.offsetUnit} = 'utf16_code_unit'`,
    ),
    check(
      'processor_result_evidence_text_range_valid',
      sql`${table.startUtf16} >= 0 and ${table.startUtf16} < ${table.endUtf16}`,
    ),
    check(
      'processor_result_evidence_audio_range_valid',
      sql`(${table.startMs} is null and ${table.endMs} is null) or (${table.startMs} >= 0 and ${table.startMs} < ${table.endMs})`,
    ),
    check(
      'processor_result_evidence_quote_hash_sha256',
      sql`${table.quoteHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'processor_result_evidence_resolution_consistent',
      sql`(${table.resolutionStatus} = 'resolved' and ${table.unresolvedReason} is null) or (${table.resolutionStatus} <> 'resolved' and ${table.unresolvedReason} is not null)`,
    ),
    check(
      'processor_result_evidence_reason_code_valid',
      sql`${table.unresolvedReason} is null or ${table.unresolvedReason} ~ '^[a-z][a-z0-9_]{0,63}$'`,
    ),
  ],
);

export const processorApiIdempotency = journalSchema.table(
  'processor_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    response: jsonb('response')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'processor_api_idempotency_pk',
      columns: [table.ownerId, table.operation, table.idempotencyKey],
    }),
    check(
      'processor_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'processor_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'processor_api_idempotency_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
  ],
);

/** One explicitly confirmed historical reprocessing operation. */
export const reprocessingBatches = journalSchema.table(
  'reprocessing_batch',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull().default(1),
    state: text('state').notNull().default('active'),
    target: jsonb('target')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    versionBasis: jsonb('version_basis')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    impact: jsonb('impact')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    impactFingerprint: text('impact_fingerprint').notNull(),
    correlationId: uuid('correlation_id').notNull(),
    cancelRequestedAt: timestamp('cancel_requested_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('reprocessing_batch_owner_created_idx').on(
      table.ownerId,
      table.createdAt,
      table.id,
    ),
    check(
      'reprocessing_batch_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('reprocessing_batch_revision_positive', sql`${table.revision} > 0`),
    check(
      'reprocessing_batch_state_valid',
      sql`${table.state} in ('active', 'canceled')`,
    ),
    check(
      'reprocessing_batch_impact_hash_sha256',
      sql`${table.impactFingerprint} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'reprocessing_batch_cancel_consistent',
      sql`(${table.state} = 'active' and ${table.cancelRequestedAt} is null) or (${table.state} = 'canceled' and ${table.cancelRequestedAt} is not null)`,
    ),
  ],
);

/** Identifier-only membership links a batch to immutable-version processor runs. */
export const reprocessingBatchItems = journalSchema.table(
  'reprocessing_batch_item',
  {
    batchId: uuid('batch_id')
      .notNull()
      .references(() => reprocessingBatches.id, { onDelete: 'restrict' }),
    ordinal: integer('ordinal').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => processorRuns.id, { onDelete: 'restrict' }),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    journalDayId: uuid('journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    contributionId: uuid('contribution_id').references(() => contributions.id, {
      onDelete: 'restrict',
    }),
    providerOperationCount: integer('provider_operation_count')
      .notNull()
      .default(0),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'reprocessing_batch_item_pk',
      columns: [table.batchId, table.ordinal],
    }),
    uniqueIndex('reprocessing_batch_item_run_unique').on(table.runId),
    index('reprocessing_batch_item_version_target_idx').on(
      table.processorVersionId,
      table.journalDayId,
    ),
    check(
      'reprocessing_batch_item_ordinal_nonnegative',
      sql`${table.ordinal} >= 0`,
    ),
    check(
      'reprocessing_batch_item_provider_count_nonnegative',
      sql`${table.providerOperationCount} >= 0`,
    ),
  ],
);

export const reprocessingApiIdempotency = journalSchema.table(
  'reprocessing_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    batchId: uuid('batch_id')
      .notNull()
      .references(() => reprocessingBatches.id, { onDelete: 'restrict' }),
    response: jsonb('response')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    primaryKey({
      name: 'reprocessing_api_idempotency_pk',
      columns: [table.ownerId, table.operation, table.idempotencyKey],
    }),
    check(
      'reprocessing_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'reprocessing_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'reprocessing_api_idempotency_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
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

export const memories = journalSchema.table(
  'memory',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    currentRevisionId: uuid('current_revision_id').notNull(),
    currentRevision: integer('current_revision').notNull(),
    approvalState: memoryApprovalState('approval_state').notNull(),
    enabled: boolean('enabled').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('memory_owner_current_idx').on(table.ownerId, table.id),
    index('memory_owner_active_idx')
      .on(table.ownerId, table.enabled, table.id)
      .where(sql`${table.deletedAt} is null`),
    uniqueIndex('memory_current_revision_id_unique').on(
      table.currentRevisionId,
    ),
    check(
      'memory_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'memory_current_revision_positive',
      sql`${table.currentRevision} > 0`,
    ),
    check(
      'memory_activation_consistent',
      sql`${table.enabled} = false or (${table.approvalState} = 'approved' and ${table.deletedAt} is null)`,
    ),
  ],
);

export const memoryRevisions = journalSchema.table(
  'memory_revision',
  {
    id: uuid('id').primaryKey(),
    memoryId: uuid('memory_id')
      .notNull()
      .references(() => memories.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    type: memoryType('type').notNull(),
    content: text('content').notNull(),
    rationale: text('rationale').notNull(),
    creator: memoryCreator('creator').notNull(),
    approvalState: memoryApprovalState('approval_state').notNull(),
    scope: jsonb('scope').$type<Readonly<Record<string, unknown>>>().notNull(),
    enabled: boolean('enabled').notNull(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('memory_revision_number_unique').on(
      table.memoryId,
      table.revision,
    ),
    index('memory_revision_history_idx').on(table.memoryId, table.revision),
    check(
      'memory_revision_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('memory_revision_positive', sql`${table.revision} > 0`),
    check(
      'memory_revision_content_not_blank',
      sql`length(btrim(${table.content})) > 0`,
    ),
    check(
      'memory_revision_rationale_not_blank',
      sql`length(btrim(${table.rationale})) > 0`,
    ),
    check(
      'memory_revision_activation_consistent',
      sql`${table.enabled} = false or (${table.approvalState} = 'approved' and ${table.deletedAt} is null)`,
    ),
  ],
);

/** Current, independently addressable lexical retrieval material. */
export const searchFragments = journalSchema.table(
  'search_fragment',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    sourceKind: text('source_kind').notNull(),
    layer: text('layer').notNull(),
    sourceId: uuid('source_id').notNull(),
    sourceRevisionId: uuid('source_revision_id').notNull(),
    sourceRevision: integer('source_revision').notNull(),
    journalDayId: uuid('journal_day_id').references(() => journalDays.id, {
      onDelete: 'cascade',
    }),
    journalDate: date('journal_date', { mode: 'string' }),
    contributionId: uuid('contribution_id').references(() => contributions.id, {
      onDelete: 'cascade',
    }),
    transcriptId: uuid('transcript_id').references(() => transcripts.id, {
      onDelete: 'cascade',
    }),
    artifactId: uuid('artifact_id').references(() => processorArtifacts.id, {
      onDelete: 'cascade',
    }),
    memoryId: uuid('memory_id').references(() => memories.id, {
      onDelete: 'cascade',
    }),
    processorId: uuid('processor_id').references(
      () => processorInstallations.id,
      { onDelete: 'restrict' },
    ),
    processorVersionId: uuid('processor_version_id').references(
      () => processorVersions.id,
      { onDelete: 'restrict' },
    ),
    contributionType: text('contribution_type'),
    resultType: text('result_type'),
    authority: contributionAuthority('authority').notNull(),
    content: text('content').notNull(),
    searchVector: tsvector('search_vector')
      .generatedAlwaysAs(
        (): ReturnType<typeof sql> =>
          sql`to_tsvector('english', coalesce(content, ''))`,
      )
      .notNull(),
    indexedAt: timestamp('indexed_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('search_fragment_source_revision_unique').on(
      table.sourceKind,
      table.sourceRevisionId,
    ),
    index('search_fragment_vector_idx').using('gin', table.searchVector),
    index('search_fragment_owner_rank_idx').on(
      table.ownerId,
      table.journalDate,
      table.id,
    ),
    index('search_fragment_filter_idx').on(
      table.ownerId,
      table.layer,
      table.authority,
      table.processorId,
    ),
    check(
      'search_fragment_revision_positive',
      sql`${table.sourceRevision} > 0`,
    ),
    check(
      'search_fragment_content_not_blank',
      sql`length(btrim(${table.content})) > 0`,
    ),
    check(
      'search_fragment_source_kind_valid',
      sql`${table.sourceKind} in ('contribution_revision', 'transcript_revision', 'artifact_version', 'artifact_manual_revision', 'memory_revision')`,
    ),
    check(
      'search_fragment_layer_valid',
      sql`${table.layer} in ('typed_text', 'nudge_response', 'raw_stt', 'corrected', 'cleaned', 'observation', 'interpretation', 'summary', 'memory')`,
    ),
    check(
      'search_fragment_location_consistent',
      sql`(${table.memoryId} is not null and ${table.journalDayId} is null and ${table.journalDate} is null) or (${table.memoryId} is null and ${table.journalDayId} is not null and ${table.journalDate} is not null)`,
    ),
  ],
);

export const feedback = journalSchema.table(
  'feedback',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    targetKind: feedbackTargetKind('target_kind').notNull(),
    targetId: uuid('target_id').notNull(),
    message: text('message').notNull(),
    classifiedScope: jsonb('classified_scope')
      .$type<Readonly<Record<string, unknown>>>()
      .notNull(),
    resultingMemoryId: uuid('resulting_memory_id').references(
      () => memories.id,
      { onDelete: 'restrict' },
    ),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index('feedback_owner_target_idx').on(
      table.ownerId,
      table.targetKind,
      table.targetId,
    ),
    check(
      'feedback_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'feedback_message_not_blank',
      sql`length(btrim(${table.message})) > 0`,
    ),
  ],
);

export const memoryApiIdempotency = journalSchema.table(
  'memory_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    feedbackId: uuid('feedback_id').references(() => feedback.id, {
      onDelete: 'restrict',
    }),
    memoryId: uuid('memory_id').references(() => memories.id, {
      onDelete: 'restrict',
    }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('memory_api_idempotency_owner_operation_key_unique').on(
      table.ownerId,
      table.operation,
      table.idempotencyKey,
    ),
    check(
      'memory_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'memory_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'memory_api_idempotency_request_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'memory_api_idempotency_result_present',
      sql`num_nonnulls(${table.feedbackId}, ${table.memoryId}) > 0`,
    ),
  ],
);

export const nudgePreferences = journalSchema.table(
  'nudge_preference',
  {
    ownerId: uuid('owner_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    quietStartHour: integer('quiet_start_hour').notNull().default(21),
    quietEndHour: integer('quiet_end_hour').notNull().default(8),
    dailyLimit: integer('daily_limit').notNull().default(1),
    revision: integer('revision').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    check(
      'nudge_preference_hours_valid',
      sql`${table.quietStartHour} between 0 and 23 and ${table.quietEndHour} between 0 and 23 and ${table.quietStartHour} <> ${table.quietEndHour}`,
    ),
    check(
      'nudge_preference_daily_limit_valid',
      sql`${table.dailyLimit} between 0 and 24`,
    ),
    check('nudge_preference_revision_positive', sql`${table.revision} > 0`),
  ],
);

export const requirementEvaluations = journalSchema.table(
  'requirement_evaluation',
  {
    id: uuid('id').primaryKey(),
    journalDayId: uuid('journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    processorId: uuid('processor_id')
      .notNull()
      .references(() => processorInstallations.id, { onDelete: 'restrict' }),
    processorVersionId: uuid('processor_version_id')
      .notNull()
      .references(() => processorVersions.id, { onDelete: 'restrict' }),
    supportingRunId: uuid('supporting_run_id').references(
      () => processorRuns.id,
      { onDelete: 'restrict' },
    ),
    state: requirementEvaluationState('state')
      .notNull()
      .default('not_evaluated'),
    revision: integer('revision').notNull().default(1),
    manualResolution: boolean('manual_resolution').notNull().default(false),
    responseContributionId: uuid('response_contribution_id').references(
      () => contributions.id,
      { onDelete: 'restrict' },
    ),
    evaluatedAt: timestamp('evaluated_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('requirement_evaluation_day_version_unique').on(
      table.journalDayId,
      table.processorVersionId,
    ),
    index('requirement_evaluation_state_day_idx').on(
      table.state,
      table.journalDayId,
    ),
    check(
      'requirement_evaluation_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'requirement_evaluation_revision_positive',
      sql`${table.revision} > 0`,
    ),
    check(
      'requirement_evaluation_manual_consistent',
      sql`(${table.manualResolution} = false and ${table.responseContributionId} is null) or (${table.manualResolution} = true and ${table.state} in ('satisfied', 'dismissed', 'not_applicable') and ${table.responseContributionId} is not null)`,
    ),
    check(
      'requirement_evaluation_run_consistent',
      sql`(${table.state} = 'not_evaluated' and ${table.evaluatedAt} is null) or (${table.state} <> 'not_evaluated' and ${table.evaluatedAt} is not null)`,
    ),
  ],
);

export const nudgeDigests = journalSchema.table(
  'nudge_digest',
  {
    id: uuid('id').primaryKey(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    journalDayId: uuid('journal_day_id')
      .notNull()
      .references(() => journalDays.id, { onDelete: 'restrict' }),
    notificationDate: date('notification_date', { mode: 'string' }).notNull(),
    status: nudgeDigestStatus('status').notNull().default('queued'),
    revision: integer('revision').notNull().default(1),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }),
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('nudge_digest_journal_day_unique').on(table.journalDayId),
    index('nudge_digest_delivery_idx').on(table.status, table.scheduledAt),
    index('nudge_digest_owner_notification_date_idx').on(
      table.ownerId,
      table.notificationDate,
    ),
    check(
      'nudge_digest_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check('nudge_digest_revision_positive', sql`${table.revision} > 0`),
    check(
      'nudge_digest_published_consistent',
      sql`(${table.status} = 'published' and ${table.publishedAt} is not null) or (${table.status} <> 'published')`,
    ),
    check(
      'nudge_digest_deferred_consistent',
      sql`(${table.status} = 'deferred' and ${table.deferredUntil} is not null) or (${table.status} <> 'deferred' and ${table.deferredUntil} is null)`,
    ),
  ],
);

export const nudgeItems = journalSchema.table(
  'nudge_item',
  {
    id: uuid('id').primaryKey(),
    digestId: uuid('digest_id')
      .notNull()
      .references(() => nudgeDigests.id, { onDelete: 'restrict' }),
    evaluationId: uuid('evaluation_id')
      .notNull()
      .references(() => requirementEvaluations.id, { onDelete: 'restrict' }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('nudge_item_digest_evaluation_unique').on(
      table.digestId,
      table.evaluationId,
    ),
    uniqueIndex('nudge_item_evaluation_unique').on(table.evaluationId),
    check(
      'nudge_item_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
  ],
);

export const nudgeActions = journalSchema.table(
  'nudge_action',
  {
    id: uuid('id').primaryKey(),
    digestId: uuid('digest_id')
      .notNull()
      .references(() => nudgeDigests.id, { onDelete: 'restrict' }),
    itemId: uuid('item_id').references(() => nudgeItems.id, {
      onDelete: 'restrict',
    }),
    actorId: uuid('actor_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    action: nudgeActionKind('action').notNull(),
    responseContributionId: uuid('response_contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'restrict' }),
    deferredUntil: timestamp('deferred_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('nudge_action_response_contribution_unique').on(
      table.responseContributionId,
    ),
    check(
      'nudge_action_id_uuid_v7',
      sql`substring(${table.id}::text from 15 for 1) = '7'`,
    ),
    check(
      'nudge_action_item_consistent',
      sql`(${table.action} in ('answer', 'not_applicable') and ${table.itemId} is not null) or (${table.action} in ('defer', 'dismiss') and ${table.itemId} is null)`,
    ),
    check(
      'nudge_action_defer_consistent',
      sql`(${table.action} = 'defer' and ${table.deferredUntil} is not null) or (${table.action} <> 'defer' and ${table.deferredUntil} is null)`,
    ),
  ],
);

export const nudgeApiIdempotency = journalSchema.table(
  'nudge_api_idempotency',
  {
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    operation: text('operation').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    digestId: uuid('digest_id').references(() => nudgeDigests.id, {
      onDelete: 'restrict',
    }),
    actionId: uuid('action_id').references(() => nudgeActions.id, {
      onDelete: 'restrict',
    }),
    responseContributionId: uuid('response_contribution_id').references(
      () => contributions.id,
      { onDelete: 'restrict' },
    ),
    preferenceRevision: integer('preference_revision'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('nudge_api_idempotency_owner_operation_key_unique').on(
      table.ownerId,
      table.operation,
      table.idempotencyKey,
    ),
    check(
      'nudge_api_idempotency_operation_not_blank',
      sql`length(${table.operation}) > 0`,
    ),
    check(
      'nudge_api_idempotency_key_not_blank',
      sql`length(${table.idempotencyKey}) > 0`,
    ),
    check(
      'nudge_api_idempotency_request_hash_sha256',
      sql`${table.requestHash} ~ '^[0-9a-f]{64}$'`,
    ),
    check(
      'nudge_api_idempotency_result_consistent',
      sql`(num_nonnulls(${table.digestId}, ${table.actionId}, ${table.responseContributionId}) = 3 and ${table.preferenceRevision} is null) or (num_nonnulls(${table.digestId}, ${table.actionId}, ${table.responseContributionId}) = 0 and ${table.preferenceRevision} is not null and ${table.preferenceRevision} > 0)`,
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
  artifactApiIdempotency,
  authChallenges,
  authenticators,
  auditEvents,
  contributionRevisions,
  contributions,
  developmentFixtures,
  feedback,
  journalDays,
  journalApiIdempotency,
  memories,
  memoryApiIdempotency,
  memoryRevisions,
  nudgeActions,
  nudgeApiIdempotency,
  nudgeDigests,
  nudgeItems,
  nudgePreferences,
  passwordCredentials,
  processorApiIdempotency,
  processorArtifacts,
  processorArtifactCandidates,
  processorArtifactManualRevisions,
  processorArtifactVersions,
  processorInstallations,
  processorReconciliationOutcomes,
  processorReconciliations,
  processorResultEvidence,
  processorResults,
  processorRunInputs,
  processorRuns,
  processorVersionDependencies,
  processorVersions,
  requirementEvaluations,
  reprocessingApiIdempotency,
  reprocessingBatchItems,
  reprocessingBatches,
  queueConfigurations,
  recoveryCodes,
  recordingApiIdempotency,
  recordingChunks,
  recordings,
  recordingUploads,
  schedules,
  searchFragments,
  sessions,
  transcriptCleanupRuns,
  transcriptionRuns,
  transcriptEvidenceSpans,
  transcriptRevisions,
  transcriptSegments,
  transcripts,
  users,
};
