import { z } from 'zod';

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
      },
      schemas: {
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
