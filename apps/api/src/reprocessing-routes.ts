import {
  conditionalMutationHeadersSchema,
  cursorPaginationRequestSchema,
  idempotentMutationHeadersSchema,
  reprocessingBatchMutationResponseSchema,
  reprocessingBatchPageSchema,
  reprocessingBatchSchema,
  reprocessingPreviewRequestSchema,
  reprocessingPreviewResponseSchema,
  startReprocessingRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import { DomainInvariantError } from '@journal/domain';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  ReprocessingConflictError,
  ReprocessingNotFoundError,
} from './reprocessing-service.js';
import type { ApiDependencies } from './types.js';

const paramsSchema = z.strictObject({ id: uuidV7Schema });

function invalidParameters(
  issues: readonly ZodIssue[],
  location: 'body' | 'header' | 'path' | 'query',
) {
  return issues.map((entry) => ({
    name: entry.path.map(String).join('.') || 'request',
    location,
    reason: entry.message,
  }));
}

function parse<T>(
  request: Request,
  response: Response,
  schema: z.ZodType<T>,
  value: unknown,
  location: 'body' | 'header' | 'path' | 'query',
): T | undefined {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  sendProblem(request, response, {
    code: 'validation_failed',
    status: 400,
    title: 'Request validation failed',
    invalidParameters: invalidParameters(parsed.error.issues, location),
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

function expectedRevision(etag: string): number | undefined {
  const match = /^"reprocessing-(0|[1-9][0-9]*)"$/.exec(etag);
  const value = Number(match?.[1]);
  return Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function setEtag(response: Response, revision: number): void {
  response.set('etag', `"reprocessing-${revision}"`);
}

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerReprocessingRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.reprocessingService;
  if (service === undefined) return;

  app.post(
    '/api/v1/processing-runs/reprocessing/preview',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const body = parse(
        request,
        response,
        reprocessingPreviewRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || body === undefined) return;
      sendValidated(
        response,
        reprocessingPreviewResponseSchema,
        await service.preview(owner.ownerId, body),
      );
    }),
  );

  app.post(
    '/api/v1/reprocessing-batches',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const headers = idempotencyHeaders(request, response);
      const body = parse(
        request,
        response,
        startReprocessingRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || headers === undefined || body === undefined)
        return;
      const result = await service.start(
        owner.ownerId,
        body.preview,
        body.impactFingerprint,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.batch.revision);
      sendValidated(
        response,
        reprocessingBatchMutationResponseSchema,
        {
          batch: result.batch,
          idempotency: {
            key: headers['idempotency-key'],
            replayed: result.replayed,
          },
        },
        201,
      );
    }),
  );

  app.get(
    '/api/v1/reprocessing-batches',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      const query = parse(
        request,
        response,
        cursorPaginationRequestSchema,
        request.query,
        'query',
      );
      if (owner === undefined || query === undefined) return;
      const page = await service.list(owner.ownerId, {
        limit: query.limit,
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      });
      sendValidated(response, reprocessingBatchPageSchema, {
        items: [...page.items],
        page: {
          hasMore: page.nextCursor !== undefined,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        },
      });
    }),
  );

  app.get(
    '/api/v1/reprocessing-batches/:id',
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
      const batch = await service.get(owner.ownerId, params.id);
      setEtag(response, batch.revision);
      sendValidated(response, reprocessingBatchSchema, batch);
    }),
  );

  app.post(
    '/api/v1/reprocessing-batches/:id/cancel',
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
      if (owner === undefined || params === undefined || headers === undefined)
        return;
      const revision = expectedRevision(headers['if-match']);
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid reprocessing ETag',
        });
        return;
      }
      const result = await service.cancel(
        owner.ownerId,
        params.id,
        revision,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.batch.revision);
      sendValidated(response, reprocessingBatchMutationResponseSchema, {
        batch: result.batch,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendReprocessingError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof ReprocessingNotFoundError) {
    sendProblem(request, response, {
      code: 'reprocessing_not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof ReprocessingConflictError) {
    sendProblem(request, response, {
      code: 'reprocessing_conflict',
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
