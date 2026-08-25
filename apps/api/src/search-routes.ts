import {
  groundedAnswerRequestSchema,
  groundedAnswerSchema,
  idempotentMutationHeadersSchema,
  lexicalSearchPageSchema,
  lexicalSearchRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import type { Express, NextFunction, Request, Response } from 'express';

import { sendProblem, sendValidated } from './http.js';
import { isActiveSession } from './auth.js';
import { SearchCursorError } from './search-service.js';
import {
  GroundedAnswerIdempotencyConflictError,
  GroundedAnswerNotFoundError,
} from './grounded-answer-service.js';
import type { ApiDependencies } from './types.js';

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerSearchRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.searchService;
  const groundedAnswers = dependencies.groundedAnswerService;
  if (service === undefined && groundedAnswers === undefined) return;
  if (service !== undefined)
    app.get(
      '/api/v1/search',
      wrap(async (request, response) => {
        const owner = await dependencies.authenticator.authenticate(request);
        if (owner === undefined) {
          sendProblem(request, response, {
            code: 'authentication_required',
            status: 401,
            title: 'Authentication required',
          });
          return;
        }
        const parsed = lexicalSearchRequestSchema.safeParse(request.query);
        if (!parsed.success) {
          sendProblem(request, response, {
            code: 'validation_failed',
            status: 400,
            title: 'Request validation failed',
            invalidParameters: parsed.error.issues.map((issue) => ({
              name: issue.path.map(String).join('.') || 'request',
              location: 'query' as const,
              reason: issue.message,
            })),
          });
          return;
        }
        response.set('cache-control', 'private, no-store');
        const result = await service.search(owner.ownerId, parsed.data);
        sendValidated(response, lexicalSearchPageSchema, {
          items: [...result.items],
          retrieval: result.retrieval,
          page: {
            hasMore: result.nextCursor !== undefined,
            ...(result.nextCursor === undefined
              ? {}
              : { nextCursor: result.nextCursor }),
          },
        });
      }),
    );
  if (groundedAnswers !== undefined) {
    app.post(
      '/api/v1/search/answers',
      wrap(async (request, response) => {
        const owner = await dependencies.authenticator.authenticate(request);
        if (owner === undefined) {
          sendProblem(request, response, {
            code: 'authentication_required',
            status: 401,
            title: 'Authentication required',
          });
          return;
        }
        if (dependencies.authenticationService !== undefined) {
          if (!isActiveSession(owner)) {
            sendProblem(request, response, {
              code: 'forbidden',
              status: 403,
              title: 'Session authentication required',
            });
            return;
          }
          dependencies.authenticationService.assertCsrf(request, owner);
        }
        const headers = idempotentMutationHeadersSchema.safeParse({
          'idempotency-key': request.get('idempotency-key'),
        });
        if (!headers.success) {
          sendProblem(request, response, {
            code:
              request.get('idempotency-key') === undefined
                ? 'idempotency_key_required'
                : 'validation_failed',
            status: request.get('idempotency-key') === undefined ? 428 : 400,
            title:
              request.get('idempotency-key') === undefined
                ? 'Idempotency-Key is required'
                : 'Request validation failed',
          });
          return;
        }
        const parsed = groundedAnswerRequestSchema.safeParse(request.body);
        if (!parsed.success) {
          sendProblem(request, response, {
            code: 'validation_failed',
            status: 400,
            title: 'Request validation failed',
            invalidParameters: parsed.error.issues.map((issue) => ({
              name: issue.path.map(String).join('.') || 'request',
              location: 'body' as const,
              reason: issue.message,
            })),
          });
          return;
        }
        response.set('cache-control', 'private, no-store');
        sendValidated(
          response,
          groundedAnswerSchema,
          await groundedAnswers.ask(
            owner.ownerId,
            parsed.data,
            headers.data['idempotency-key'],
          ),
          202,
        );
      }),
    );
    app.get(
      '/api/v1/search/answers/:id',
      wrap(async (request, response) => {
        const owner = await dependencies.authenticator.authenticate(request);
        if (owner === undefined) {
          sendProblem(request, response, {
            code: 'authentication_required',
            status: 401,
            title: 'Authentication required',
          });
          return;
        }
        const id = uuidV7Schema.safeParse(request.params.id);
        if (!id.success) {
          sendProblem(request, response, {
            code: 'validation_failed',
            status: 400,
            title: 'Request validation failed',
          });
          return;
        }
        response.set('cache-control', 'private, no-store');
        sendValidated(
          response,
          groundedAnswerSchema,
          await groundedAnswers.get(owner.ownerId, id.data),
        );
      }),
    );
  }
}

export function sendSearchError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof GroundedAnswerNotFoundError) {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: 'Grounded answer not found',
    });
    return true;
  }
  if (error instanceof GroundedAnswerIdempotencyConflictError) {
    sendProblem(request, response, {
      code: 'idempotency_conflict',
      status: 409,
      title: 'Idempotency conflict',
      detail: error.message,
    });
    return true;
  }
  if (!(error instanceof SearchCursorError)) return false;
  sendProblem(request, response, {
    code: 'invalid_cursor',
    status: 400,
    title: 'Search cursor is invalid',
    detail: error.message,
  });
  return true;
}
