import { z } from 'zod';

import { sseEventEnvelopeSchema } from './events.js';
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
import { persistedExtensibleValueSchema } from './persisted-values.js';
import { problemDetailsSchema } from './problem-details.js';
import { semanticJsonValueSchema } from './semantic-value.js';

function componentSchema(schema: z.ZodType): Record<string, unknown> {
  const component: Record<string, unknown> = { ...z.toJSONSchema(schema) };
  Reflect.deleteProperty(component, '$schema');
  return component;
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
    servers: [{ url: 'http://localhost:3000/api/v1' }],
    paths: {},
    components: {
      schemas: {
        ConditionalMutationHeaders: componentSchema(
          conditionalMutationHeadersSchema,
        ),
        CursorPageMetadata: componentSchema(cursorPageMetadataSchema),
        CursorPaginationRequest: componentSchema(cursorPaginationRequestSchema),
        EditableResponseHeaders: componentSchema(editableResponseHeadersSchema),
        IdempotencyResponseMetadata: componentSchema(
          idempotencyResponseMetadataSchema,
        ),
        IdempotentMutationHeaders: componentSchema(
          idempotentMutationHeadersSchema,
        ),
        PersistedExtensibleValue: componentSchema(
          persistedExtensibleValueSchema,
        ),
        ProblemDetails: componentSchema(problemDetailsSchema),
        SemanticJsonValue: componentSchema(semanticJsonValueSchema),
        SseEventEnvelope: componentSchema(sseEventEnvelopeSchema),
      },
    },
  };
}

export function serializeOpenApiDocument(): string {
  return `${JSON.stringify(createOpenApiDocument(), null, 2)}\n`;
}
