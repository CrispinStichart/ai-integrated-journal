import {
  conditionalMutationHeadersSchema,
  createFeedbackRequestSchema,
  feedbackMutationResponseSchema,
  idempotentMutationHeadersSchema,
  memoryMutationRequestSchema,
  memoryMutationResponseSchema,
  memoryPageSchema,
  memoryResourceSchema,
  memorySearchRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import { DomainInvariantError } from '@journal/domain';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import { MemoryConflictError, MemoryNotFoundError } from './memory-service.js';
import type { ApiDependencies } from './types.js';

const paramsSchema = z.strictObject({ id: uuidV7Schema });

function parse<T>(
  request: Request,
  response: Response,
  schema: z.ZodType<T>,
  value: unknown,
  location: 'body' | 'header' | 'path' | 'query',
): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  sendProblem(request, response, {
    code: 'validation_failed',
    status: 400,
    title: 'Request validation failed',
    invalidParameters: result.error.issues.map((issue: ZodIssue) => ({
      name: issue.path.map(String).join('.') || 'request',
      location,
      reason: issue.message,
    })),
  });
  return undefined;
}

async function principal(
  request: Request,
  response: Response,
  dependencies: ApiDependencies,
  mutation = false,
) {
  const value = await dependencies.authenticator.authenticate(request);
  if (value === undefined) {
    sendProblem(request, response, {
      code: 'authentication_required',
      status: 401,
      title: 'Authentication required',
    });
    return undefined;
  }
  if (mutation && dependencies.authenticationService !== undefined) {
    if (!isActiveSession(value)) {
      sendProblem(request, response, {
        code: 'forbidden',
        status: 403,
        title: 'Session authentication required',
      });
      return undefined;
    }
    dependencies.authenticationService.assertCsrf(request, value);
  }
  return value;
}

function idempotencyHeaders(request: Request, response: Response) {
  if (request.get('idempotency-key') === undefined) {
    sendProblem(request, response, {
      code: 'idempotency_key_required',
      status: 428,
      title: 'Idempotency-Key header required',
    });
    return undefined;
  }
  return parse(
    request,
    response,
    idempotentMutationHeadersSchema,
    { 'idempotency-key': request.get('idempotency-key') },
    'header',
  );
}

function conditionalHeaders(request: Request, response: Response) {
  if (
    request.get('idempotency-key') === undefined ||
    request.get('if-match') === undefined
  ) {
    sendProblem(request, response, {
      code: 'precondition_required',
      status: 428,
      title: 'Conditional idempotent headers required',
    });
    return undefined;
  }
  return parse(
    request,
    response,
    conditionalMutationHeadersSchema,
    {
      'idempotency-key': request.get('idempotency-key'),
      'if-match': request.get('if-match'),
    },
    'header',
  );
}

function revision(etag: string): number | undefined {
  const match = /^"memory-([1-9][0-9]*)"$/.exec(etag);
  const parsed = Number(match?.[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerMemoryRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.memoryService;
  if (service === undefined) return;
  app.get(
    '/api/v1/memories',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      const query = parse(
        request,
        response,
        memorySearchRequestSchema,
        request.query,
        'query',
      );
      if (owner === undefined || query === undefined) return;
      const result = await service.list(owner.ownerId, {
        ...(query.q === undefined ? {} : { q: query.q }),
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        includeDisabled: query.includeDisabled === 'true',
        includeDeleted: query.includeDeleted === 'true',
      });
      sendValidated(response, memoryPageSchema, {
        items: [...result.items],
        page: {
          hasMore: result.nextCursor !== undefined,
          ...(result.nextCursor === undefined
            ? {}
            : { nextCursor: result.nextCursor }),
        },
      });
    }),
  );
  app.get(
    '/api/v1/memories/:id',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || params === undefined) return;
      const memory = await service.get(owner.ownerId, params.id);
      response.set('etag', `"memory-${memory.revision}"`);
      sendValidated(response, memoryResourceSchema, memory);
    }),
  );
  app.post(
    '/api/v1/feedback',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const headers = idempotencyHeaders(request, response);
      const input = parse(
        request,
        response,
        createFeedbackRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || headers === undefined || input === undefined)
        return;
      const result = await service.createFeedback(
        owner.ownerId,
        input,
        headers['idempotency-key'],
        correlationId(response),
      );
      if (result.memory !== undefined)
        response.set('etag', `"memory-${result.memory.revision}"`);
      sendValidated(
        response,
        feedbackMutationResponseSchema,
        {
          feedback: result.feedback,
          ...(result.memory === undefined ? {} : { memory: result.memory }),
          idempotency: {
            key: headers['idempotency-key'],
            replayed: result.replayed,
          },
        },
        201,
      );
    }),
  );
  app.post(
    '/api/v1/memories/:id/mutations',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      const headers = conditionalHeaders(request, response);
      const input = parse(
        request,
        response,
        memoryMutationRequestSchema,
        request.body,
        'body',
      );
      if (
        owner === undefined ||
        params === undefined ||
        headers === undefined ||
        input === undefined
      )
        return;
      const expectedRevision = revision(headers['if-match']);
      if (expectedRevision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid memory ETag',
        });
        return;
      }
      const result = await service.mutate(
        owner.ownerId,
        params.id,
        expectedRevision,
        input,
        headers['idempotency-key'],
        correlationId(response),
      );
      response.set('etag', `"memory-${result.memory.revision}"`);
      sendValidated(response, memoryMutationResponseSchema, {
        memory: result.memory,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendMemoryError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof MemoryNotFoundError) {
    sendProblem(request, response, {
      code: 'memory_not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof MemoryConflictError) {
    sendProblem(request, response, {
      code: 'memory_conflict',
      status: 409,
      title: error.message,
    });
    return true;
  }
  if (error instanceof DomainInvariantError) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: error.message,
    });
    return true;
  }
  return false;
}
