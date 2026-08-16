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
        CursorPageMetadata: componentSchema(cursorPageMetadataSchema),
        CursorPaginationRequest: componentSchema(cursorPaginationRequestSchema),
        EditableResponseHeaders: componentSchema(editableResponseHeadersSchema),
        EventPollRequest: componentSchema(eventPollRequestSchema),
        EventPollResponse: componentSchema(eventPollResponseSchema),
        HealthDependency: componentSchema(healthDependencySchema),
        HealthDetailsResponse: componentSchema(healthDetailsResponseSchema),
        IdempotencyResponseMetadata: componentSchema(
          idempotencyResponseMetadataSchema,
        ),
        IdempotentMutationHeaders: componentSchema(
          idempotentMutationHeadersSchema,
        ),
        LivenessResponse: componentSchema(livenessResponseSchema),
        LogoutResponse: componentSchema(logoutResponseSchema),
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
