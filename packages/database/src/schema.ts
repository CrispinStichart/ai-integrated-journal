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
        }>[]
      >()
      .notNull()
      .default([]),
    effectiveContext: jsonb('effective_context').$type<
      readonly Readonly<{
        text: string;
        purpose: string;
        version?: string;
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
    sourceRunId: uuid('source_run_id')
      .notNull()
      .references(() => transcriptionRuns.id, { onDelete: 'restrict' }),
    revision: integer('revision').notNull(),
    text: text('text').notNull(),
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
    contentHash: text('content_hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex('transcript_revision_number_unique').on(
      table.transcriptId,
      table.revision,
    ),
    uniqueIndex('transcript_revision_source_run_unique').on(table.sourceRunId),
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
  journalApiIdempotency,
  passwordCredentials,
  processorInstallations,
  queueConfigurations,
  recoveryCodes,
  recordingApiIdempotency,
  recordingChunks,
  recordings,
  recordingUploads,
  schedules,
  sessions,
  transcriptionRuns,
  transcriptRevisions,
  transcripts,
  users,
};
