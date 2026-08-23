import { z } from 'zod';

import {
  artifactEditRequestSchema,
  artifactListResponseSchema,
  artifactMergeRequestSchema,
  artifactMutationResponseSchema,
  artifactResourceSchema,
} from './artifact.js';
import {
  authenticatedResponseSchema,
  authStatusResponseSchema,
  bootstrapRequestSchema,
  logoutResponseSchema,
  passkeyOptionsResponseSchema,
  passkeyVerificationRequestSchema,
  passwordLoginRequestSchema,
  passwordRecoveryRequestSchema,
} from './auth.js';
import { lastEventIdSchema, sseEventEnvelopeSchema } from './events.js';
import {
  conditionalMutationHeadersSchema,
  editableResponseHeadersSchema,
  idempotencyResponseMetadataSchema,
  idempotentMutationHeadersSchema,
} from './http-metadata.js';
import {
  contributionMutationResponseSchema,
  contributionRevisionPageSchema,
  contributionSchema,
  createContributionRequestSchema,
  editContributionRequestSchema,
  journalDaySummaryPageSchema,
  journalDayViewSchema,
  moveContributionRequestSchema,
} from './journal.js';
import {
  cursorPageMetadataSchema,
  cursorPaginationRequestSchema,
} from './pagination.js';
import {
  eventPollRequestSchema,
  eventPollResponseSchema,
  healthDependencySchema,
  healthDetailsResponseSchema,
  livenessResponseSchema,
  readinessResponseSchema,
} from './operations.js';
import { persistedExtensibleValueSchema } from './persisted-values.js';
import { problemDetailsSchema } from './problem-details.js';
import {
  createProcessorRequestSchema,
  processorDryRunRequestSchema,
  processorDryRunResponseSchema,
  processorListResponseSchema,
  processorMutationResponseSchema,
  processorResourceSchema,
  processorRunProvenanceSchema,
  publishProcessorVersionRequestSchema,
  updateProcessorRequestSchema,
} from './processor.js';
import {
  audioDeletionResponseSchema,
  createRecordingRequestSchema,
  finalizeRecordingRequestSchema,
  recordingChunkUploadResponseSchema,
  recordingMutationResponseSchema,
  recordingSchema,
  recordingUploadStatusSchema,
} from './recording.js';
import {
  reprocessingBatchMutationResponseSchema,
  reprocessingBatchPageSchema,
  reprocessingBatchSchema,
  reprocessingPreviewRequestSchema,
  reprocessingPreviewResponseSchema,
  startReprocessingRequestSchema,
} from './reprocessing.js';
import { semanticJsonValueSchema } from './semantic-value.js';
import { uuidV7Schema } from './primitives.js';
import {
  editCorrectedTranscriptRequestSchema,
  recordingTranscriptInspectorSchema,
  transcriptMutationResponseSchema,
  transcriptRevisionHistorySchema,
} from './transcription.js';

function componentSchema(schema: z.ZodType): Record<string, unknown> {
  const component: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  Reflect.deleteProperty(component, '$schema');
  return component;
}

function schemaResponse(
  description: string,
  schemaName: string,
  contentType = 'application/json',
): Record<string, unknown> {
  return {
    description,
    content: {
      [contentType]: {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

function problemResponse(description: string): Record<string, unknown> {
  return schemaResponse(
    description,
    'ProblemDetails',
    'application/problem+json',
  );
}

function jsonRequest(schemaName: string): Record<string, unknown> {
  return {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: `#/components/schemas/${schemaName}` },
      },
    },
  };
}

function processorIdParameter(): Record<string, unknown> {
  return {
    in: 'path',
    name: 'id',
    required: true,
    schema: componentSchema(uuidV7Schema),
  };
}

export function createOpenApiDocument(): Record<string, unknown> {
  return {
    openapi: '3.1.1',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'AI-Integrated Journal API',
      version: '1.0.0',
      description:
        'Shared foundational contracts for the versioned local journal API.',
    },
    servers: [{ url: 'http://localhost:3000' }],
    paths: {
      '/api/v1/auth/status': {
        get: {
          responses: {
            '200': schemaResponse('Authentication state', 'AuthStatusResponse'),
          },
        },
      },
      '/api/v1/auth/bootstrap': {
        post: {
          requestBody: jsonRequest('BootstrapRequest'),
          responses: {
            '201': schemaResponse('Owner provisioned', 'AuthenticatedResponse'),
            '409': problemResponse('Owner already provisioned'),
            '429': problemResponse('Rate limited'),
          },
        },
      },
      '/api/v1/auth/password/login': {
        post: {
          requestBody: jsonRequest('PasswordLoginRequest'),
          responses: {
            '200': schemaResponse('Authenticated', 'AuthenticatedResponse'),
            '401': problemResponse('Invalid credentials'),
            '429': problemResponse('Rate limited'),
          },
        },
      },
      '/api/v1/auth/password/recover': {
        post: {
          requestBody: jsonRequest('PasswordRecoveryRequest'),
          responses: {
            '200': schemaResponse(
              'Password reset and authenticated',
              'AuthenticatedResponse',
            ),
            '401': problemResponse('Invalid recovery code'),
            '429': problemResponse('Rate limited'),
          },
        },
      },
      '/api/v1/auth/passkeys/registration/options': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Passkey creation options',
              'PasskeyOptionsResponse',
            ),
            '401': problemResponse('Authentication required'),
            '403': problemResponse('CSRF validation failed'),
          },
        },
      },
      '/api/v1/auth/passkeys/registration/verify': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('PasskeyVerificationRequest'),
          responses: {
            '200': schemaResponse(
              'Passkey registered and session rotated',
              'AuthenticatedResponse',
            ),
            '400': problemResponse('Invalid passkey response'),
            '403': problemResponse('CSRF validation failed'),
          },
        },
      },
      '/api/v1/auth/passkeys/authentication/options': {
        post: {
          responses: {
            '200': schemaResponse(
              'Passkey request options',
              'PasskeyOptionsResponse',
            ),
          },
        },
      },
      '/api/v1/auth/passkeys/authentication/verify': {
        post: {
          requestBody: jsonRequest('PasskeyVerificationRequest'),
          responses: {
            '200': schemaResponse('Authenticated', 'AuthenticatedResponse'),
            '401': problemResponse('Passkey verification failed'),
          },
        },
      },
      '/api/v1/auth/logout': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Session revoked and caches cleared',
              'LogoutResponse',
            ),
            '401': problemResponse('Authentication required'),
            '403': problemResponse('CSRF validation failed'),
          },
        },
      },
      '/api/v1/journal-days': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Deterministic calendar summary page',
              'JournalDaySummaryPage',
            ),
            '400': problemResponse('Invalid cursor'),
            '401': problemResponse('Authentication required'),
          },
        },
      },
      '/api/v1/journal-days/{date}': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              in: 'path',
              name: 'date',
              required: true,
              schema: { type: 'string', format: 'date' },
            },
          ],
          responses: {
            '200': schemaResponse(
              'Complete journal day view',
              'JournalDayView',
            ),
            '404': problemResponse('Journal day not found'),
          },
        },
      },
      '/api/v1/contributions': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('CreateContributionRequest'),
          responses: {
            '201': schemaResponse(
              'Contribution created',
              'ContributionMutationResponse',
            ),
            '400': problemResponse('Invalid contribution'),
            '428': problemResponse('Idempotency key required'),
          },
        },
      },
      '/api/v1/contributions/{id}': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse('Contribution', 'Contribution'),
            '404': problemResponse('Contribution not found'),
          },
        },
        patch: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('EditContributionRequest'),
          responses: {
            '200': schemaResponse(
              'Contribution revised',
              'ContributionMutationResponse',
            ),
            '412': problemResponse('ETag mismatch'),
            '428': problemResponse('Precondition required'),
          },
        },
        delete: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Contribution recoverably deleted',
              'ContributionMutationResponse',
            ),
            '412': problemResponse('ETag mismatch'),
          },
        },
      },
      '/api/v1/contributions/{id}/revisions': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Immutable revision history',
              'ContributionRevisionPage',
            ),
          },
        },
      },
      '/api/v1/contributions/{id}/move': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('MoveContributionRequest'),
          responses: {
            '200': schemaResponse(
              'Contribution moved',
              'ContributionMutationResponse',
            ),
            '412': problemResponse('ETag mismatch'),
          },
        },
      },
      '/api/v1/contributions/{id}/restore': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Contribution restored',
              'ContributionMutationResponse',
            ),
            '412': problemResponse('ETag mismatch'),
          },
        },
      },
      '/api/v1/recordings': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('CreateRecordingRequest'),
          responses: {
            '201': schemaResponse(
              'Recording upload created',
              'RecordingMutationResponse',
            ),
            '409': problemResponse('Recording identity conflict'),
            '428': problemResponse('Idempotency key required'),
          },
        },
      },
      '/api/v1/recordings/{id}/chunks/{index}': {
        put: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          parameters: [
            {
              in: 'header',
              name: 'X-Content-SHA256',
              required: true,
              schema: { type: 'string', pattern: '^[0-9a-f]{64}$' },
            },
            {
              in: 'path',
              name: 'id',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
            {
              in: 'path',
              name: 'index',
              required: true,
              schema: { type: 'integer', minimum: 0 },
            },
          ],
          requestBody: {
            required: true,
            content: {
              'application/octet-stream': {
                schema: {
                  type: 'string',
                  contentMediaType: 'application/octet-stream',
                },
              },
            },
          },
          responses: {
            '201': schemaResponse(
              'Chunk accepted',
              'RecordingChunkUploadResponse',
            ),
            '409': problemResponse('Chunk checksum or identity conflict'),
            '413': problemResponse('Chunk exceeds the transport bound'),
          },
        },
      },
      '/api/v1/recordings/{id}/upload': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Accepted indexes and recording state',
              'RecordingUploadStatus',
            ),
            '404': problemResponse('Recording not found'),
          },
        },
      },
      '/api/v1/recordings/{id}/finalize': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('FinalizeRecordingRequest'),
          responses: {
            '200': schemaResponse(
              'Recording durably finalized',
              'RecordingMutationResponse',
            ),
            '409': problemResponse('Manifest conflict'),
            '507': problemResponse('Server storage exhausted'),
          },
        },
      },
      '/api/v1/recordings/{id}/retry': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Prepared finalization retried',
              'RecordingMutationResponse',
            ),
            '409': problemResponse('Recording is not prepared'),
          },
        },
      },
      '/api/v1/recordings/{id}/transcription/retry': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Failed or canceled transcription retry queued',
              'RecordingMutationResponse',
            ),
            '409': problemResponse(
              'Latest transcription has not failed or been canceled',
            ),
          },
        },
      },
      '/api/v1/recordings/{id}/audio': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              in: 'header',
              name: 'Range',
              required: false,
              schema: { type: 'string', pattern: '^bytes=' },
            },
          ],
          responses: {
            '206': {
              description: 'Bounded audio byte range',
              headers: {
                'Accept-Ranges': { schema: { const: 'bytes' } },
                'Content-Range': { schema: { type: 'string' } },
              },
              content: {
                'audio/*': {
                  schema: {
                    type: 'string',
                    contentMediaType: 'application/octet-stream',
                  },
                },
              },
            },
            '410': problemResponse('Audio recoverably deleted'),
            '416': problemResponse('Range not satisfiable'),
          },
        },
        delete: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Audio recoverably deleted',
              'AudioDeletionResponse',
            ),
          },
        },
      },
      '/api/v1/recordings/{id}/audio/restore': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Audio restored',
              'RecordingMutationResponse',
            ),
          },
        },
      },
      '/api/v1/recordings/{id}/transcripts': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Distinct transcript layers, processing state, provenance, and timed evidence',
              'RecordingTranscriptInspector',
            ),
            '404': problemResponse('Recording not found'),
          },
        },
      },
      '/api/v1/transcripts/{id}': {
        patch: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('EditCorrectedTranscriptRequest'),
          responses: {
            '200': schemaResponse(
              'Corrected transcript revised and cleanup queued',
              'TranscriptMutationResponse',
            ),
            '409': problemResponse('Cleanup configuration unavailable'),
            '412': problemResponse('Transcript ETag mismatch'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/transcripts/{id}/revisions': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Immutable transcript revision history',
              'TranscriptRevisionHistory',
            ),
            '404': problemResponse('Transcript not found'),
          },
        },
      },
      '/api/v1/transcripts/{id}/cleanup/retry': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          responses: {
            '200': schemaResponse(
              'Failed or canceled cleanup retry queued',
              'TranscriptMutationResponse',
            ),
            '409': problemResponse('Cleanup retry unavailable'),
            '412': problemResponse('Transcript ETag mismatch'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/processors': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Processor definitions',
              'ProcessorListResponse',
            ),
            '401': problemResponse('Authentication required'),
          },
        },
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('CreateProcessorRequest'),
          responses: {
            '201': schemaResponse(
              'Processor and initial immutable version published',
              'ProcessorMutationResponse',
            ),
            '400': problemResponse('Request validation failed'),
            '409': problemResponse('Processor identity or key conflict'),
            '422': problemResponse('Definition validation failed'),
            '428': problemResponse('Idempotency key required'),
          },
        },
      },
      '/api/v1/processors/{id}': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [processorIdParameter()],
          responses: {
            '200': schemaResponse(
              'Processor and immutable version history',
              'ProcessorResource',
            ),
            '404': problemResponse('Processor not found'),
          },
        },
        patch: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          parameters: [processorIdParameter()],
          requestBody: jsonRequest('UpdateProcessorRequest'),
          responses: {
            '200': schemaResponse(
              'Processor configuration updated',
              'ProcessorMutationResponse',
            ),
            '409': problemResponse('Processor configuration conflict'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/processors/{id}/versions': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          parameters: [processorIdParameter()],
          requestBody: jsonRequest('PublishProcessorVersionRequest'),
          responses: {
            '201': schemaResponse(
              'Immutable processor version published',
              'ProcessorMutationResponse',
            ),
            '409': problemResponse('Processor configuration conflict'),
            '422': problemResponse('Definition validation failed'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/processor-versions/dry-run': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('ProcessorDryRunRequest'),
          responses: {
            '200': schemaResponse(
              'Non-authoritative bounded definition validation',
              'ProcessorDryRunResponse',
            ),
            '400': problemResponse('Request validation failed'),
          },
        },
      },
      '/api/v1/processing-runs/{id}/provenance': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [processorIdParameter()],
          responses: {
            '200': schemaResponse(
              'Exact immutable processor run and result provenance',
              'ProcessorRunProvenance',
            ),
            '404': problemResponse('Processing run not found'),
          },
        },
      },
      '/api/v1/processing-runs/reprocessing/preview': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('ReprocessingPreviewRequest'),
          responses: {
            '200': schemaResponse(
              'Bounded impact and exact processor-version preview',
              'ReprocessingPreviewResponse',
            ),
            '400': problemResponse('Request validation failed'),
            '404': problemResponse('Reprocessing target not found'),
            '409': problemResponse('Scope or version basis conflict'),
          },
        },
      },
      '/api/v1/reprocessing-batches': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Paginated reprocessing audit history and progress',
              'ReprocessingBatchPage',
            ),
          },
        },
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('StartReprocessingRequest'),
          responses: {
            '201': schemaResponse(
              'Transactional reprocessing batch scheduled',
              'ReprocessingBatchMutationResponse',
            ),
            '409': problemResponse('Preview impact changed'),
            '428': problemResponse('Idempotency-Key header required'),
          },
        },
      },
      '/api/v1/reprocessing-batches/{id}': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [processorIdParameter()],
          responses: {
            '200': schemaResponse(
              'Reprocessing progress with explicit version basis',
              'ReprocessingBatch',
            ),
            '404': problemResponse('Reprocessing batch not found'),
          },
        },
      },
      '/api/v1/reprocessing-batches/{id}/cancel': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          parameters: [processorIdParameter()],
          responses: {
            '200': schemaResponse(
              'Canceled remaining reprocessing work',
              'ReprocessingBatchMutationResponse',
            ),
            '409': problemResponse('Reprocessing batch conflict'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/journal-days/{id}/artifacts': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [processorIdParameter()],
          responses: {
            '200': schemaResponse(
              'Effective generated and manual artifact views',
              'ArtifactListResponse',
            ),
            '404': problemResponse('Journal Day not found'),
          },
        },
      },
      '/api/v1/artifacts/{id}/edits': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          parameters: [processorIdParameter()],
          requestBody: jsonRequest('ArtifactEditRequest'),
          responses: {
            '200': schemaResponse(
              'Immutable manual artifact revision',
              'ArtifactMutationResponse',
            ),
            '400': problemResponse('Request validation failed'),
            '404': problemResponse('Artifact not found'),
            '409': problemResponse('Artifact or candidate conflict'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/api/v1/artifacts/merge': {
        post: {
          security: [{ sessionCookie: [], csrfToken: [] }],
          requestBody: jsonRequest('ArtifactMergeRequest'),
          responses: {
            '200': schemaResponse(
              'Atomic manual merge result',
              'ArtifactMutationResponse',
            ),
            '400': problemResponse('Request validation failed'),
            '409': problemResponse('Artifact-set conflict'),
            '428': problemResponse('Conditional idempotent headers required'),
          },
        },
      },
      '/health/live': {
        get: {
          responses: { '200': schemaResponse('Live', 'LivenessResponse') },
        },
      },
      '/health/ready': {
        get: {
          responses: {
            '200': schemaResponse('Ready', 'ReadinessResponse'),
            '503': schemaResponse(
              'Required dependency unavailable',
              'ReadinessResponse',
            ),
          },
        },
      },
      '/health/details': {
        get: {
          security: [{ sessionCookie: [] }],
          responses: {
            '200': schemaResponse(
              'Authenticated operational details',
              'HealthDetailsResponse',
            ),
            '401': problemResponse('Authentication required'),
            '503': schemaResponse(
              'Required dependency unavailable',
              'HealthDetailsResponse',
            ),
          },
        },
      },
      '/api/v1/events': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              in: 'header',
              name: 'Last-Event-ID',
              required: false,
              schema: componentSchema(lastEventIdSchema),
            },
          ],
          responses: {
            '200': schemaResponse(
              'Authenticated server-sent event stream',
              'SseEventEnvelope',
              'text/event-stream',
            ),
            '400': problemResponse('Invalid replay position'),
            '401': problemResponse('Authentication required'),
          },
        },
      },
      '/api/v1/events/poll': {
        get: {
          security: [{ sessionCookie: [] }],
          parameters: [
            {
              in: 'query',
              name: 'after',
              required: false,
              schema: componentSchema(lastEventIdSchema),
            },
          ],
          responses: {
            '200': schemaResponse(
              'Authenticated event polling fallback',
              'EventPollResponse',
            ),
            '400': problemResponse('Invalid replay position'),
            '401': problemResponse('Authentication required'),
          },
        },
      },
    },
    components: {
      securitySchemes: {
        sessionCookie: {
          type: 'apiKey',
          in: 'cookie',
          name: 'journal_session',
        },
        csrfToken: {
          type: 'apiKey',
          in: 'header',
          name: 'X-CSRF-Token',
        },
      },
      schemas: {
        ArtifactEditRequest: componentSchema(artifactEditRequestSchema),
        ArtifactListResponse: componentSchema(artifactListResponseSchema),
        ArtifactMergeRequest: componentSchema(artifactMergeRequestSchema),
        ArtifactMutationResponse: componentSchema(
          artifactMutationResponseSchema,
        ),
        ArtifactResource: componentSchema(artifactResourceSchema),
        AuthenticatedResponse: componentSchema(authenticatedResponseSchema),
        AuthStatusResponse: componentSchema(authStatusResponseSchema),
        AudioDeletionResponse: componentSchema(audioDeletionResponseSchema),
        BootstrapRequest: componentSchema(bootstrapRequestSchema),
        ConditionalMutationHeaders: componentSchema(
          conditionalMutationHeadersSchema,
        ),
        Contribution: componentSchema(contributionSchema),
        ContributionMutationResponse: componentSchema(
          contributionMutationResponseSchema,
        ),
        ContributionRevisionPage: componentSchema(
          contributionRevisionPageSchema,
        ),
        CreateContributionRequest: componentSchema(
          createContributionRequestSchema,
        ),
        CreateRecordingRequest: componentSchema(createRecordingRequestSchema),
        CursorPageMetadata: componentSchema(cursorPageMetadataSchema),
        CursorPaginationRequest: componentSchema(cursorPaginationRequestSchema),
        EditableResponseHeaders: componentSchema(editableResponseHeadersSchema),
        EventPollRequest: componentSchema(eventPollRequestSchema),
        EventPollResponse: componentSchema(eventPollResponseSchema),
        EditContributionRequest: componentSchema(editContributionRequestSchema),
        EditCorrectedTranscriptRequest: componentSchema(
          editCorrectedTranscriptRequestSchema,
        ),
        HealthDependency: componentSchema(healthDependencySchema),
        HealthDetailsResponse: componentSchema(healthDetailsResponseSchema),
        IdempotencyResponseMetadata: componentSchema(
          idempotencyResponseMetadataSchema,
        ),
        IdempotentMutationHeaders: componentSchema(
          idempotentMutationHeadersSchema,
        ),
        LivenessResponse: componentSchema(livenessResponseSchema),
        JournalDaySummaryPage: componentSchema(journalDaySummaryPageSchema),
        JournalDayView: componentSchema(journalDayViewSchema),
        LogoutResponse: componentSchema(logoutResponseSchema),
        MoveContributionRequest: componentSchema(moveContributionRequestSchema),
        FinalizeRecordingRequest: componentSchema(
          finalizeRecordingRequestSchema,
        ),
        PasskeyOptionsResponse: componentSchema(passkeyOptionsResponseSchema),
        PasskeyVerificationRequest: componentSchema(
          passkeyVerificationRequestSchema,
        ),
        PasswordLoginRequest: componentSchema(passwordLoginRequestSchema),
        PasswordRecoveryRequest: componentSchema(passwordRecoveryRequestSchema),
        PersistedExtensibleValue: componentSchema(
          persistedExtensibleValueSchema,
        ),
        ProblemDetails: componentSchema(problemDetailsSchema),
        CreateProcessorRequest: componentSchema(createProcessorRequestSchema),
        ProcessorDryRunRequest: componentSchema(processorDryRunRequestSchema),
        ProcessorDryRunResponse: componentSchema(processorDryRunResponseSchema),
        ProcessorListResponse: componentSchema(processorListResponseSchema),
        ProcessorMutationResponse: componentSchema(
          processorMutationResponseSchema,
        ),
        ProcessorResource: componentSchema(processorResourceSchema),
        ProcessorRunProvenance: componentSchema(processorRunProvenanceSchema),
        PublishProcessorVersionRequest: componentSchema(
          publishProcessorVersionRequestSchema,
        ),
        UpdateProcessorRequest: componentSchema(updateProcessorRequestSchema),
        ReadinessResponse: componentSchema(readinessResponseSchema),
        Recording: componentSchema(recordingSchema),
        RecordingChunkUploadResponse: componentSchema(
          recordingChunkUploadResponseSchema,
        ),
        RecordingMutationResponse: componentSchema(
          recordingMutationResponseSchema,
        ),
        RecordingUploadStatus: componentSchema(recordingUploadStatusSchema),
        ReprocessingBatch: componentSchema(reprocessingBatchSchema),
        ReprocessingBatchMutationResponse: componentSchema(
          reprocessingBatchMutationResponseSchema,
        ),
        ReprocessingBatchPage: componentSchema(reprocessingBatchPageSchema),
        ReprocessingPreviewRequest: componentSchema(
          reprocessingPreviewRequestSchema,
        ),
        ReprocessingPreviewResponse: componentSchema(
          reprocessingPreviewResponseSchema,
        ),
        StartReprocessingRequest: componentSchema(
          startReprocessingRequestSchema,
        ),
        RecordingTranscriptInspector: componentSchema(
          recordingTranscriptInspectorSchema,
        ),
        SemanticJsonValue: componentSchema(semanticJsonValueSchema),
        SseEventEnvelope: componentSchema(sseEventEnvelopeSchema),
        TranscriptMutationResponse: componentSchema(
          transcriptMutationResponseSchema,
        ),
        TranscriptRevisionHistory: componentSchema(
          transcriptRevisionHistorySchema,
        ),
      },
    },
  };
}

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
}
