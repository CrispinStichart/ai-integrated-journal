import { z } from 'zod';

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
import { semanticJsonValueSchema } from './semantic-value.js';

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
        AuthenticatedResponse: componentSchema(authenticatedResponseSchema),
        AuthStatusResponse: componentSchema(authStatusResponseSchema),
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
        CursorPageMetadata: componentSchema(cursorPageMetadataSchema),
        CursorPaginationRequest: componentSchema(cursorPaginationRequestSchema),
        EditableResponseHeaders: componentSchema(editableResponseHeadersSchema),
        EventPollRequest: componentSchema(eventPollRequestSchema),
        EventPollResponse: componentSchema(eventPollResponseSchema),
        EditContributionRequest: componentSchema(editContributionRequestSchema),
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
        ReadinessResponse: componentSchema(readinessResponseSchema),
        SemanticJsonValue: componentSchema(semanticJsonValueSchema),
        SseEventEnvelope: componentSchema(sseEventEnvelopeSchema),
      },
    },
  };
}

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
}
