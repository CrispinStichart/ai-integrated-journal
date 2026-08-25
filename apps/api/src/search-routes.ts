import {
  lexicalSearchPageSchema,
  lexicalSearchRequestSchema,
} from '@journal/contracts';
import type { Express, NextFunction, Request, Response } from 'express';

import { sendProblem, sendValidated } from './http.js';
import { SearchCursorError } from './search-service.js';
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
  if (service === undefined) return;
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
}

export function sendSearchError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (!(error instanceof SearchCursorError)) return false;
  sendProblem(request, response, {
    code: 'invalid_cursor',
    status: 400,
    title: 'Search cursor is invalid',
    detail: error.message,
  });
  return true;
}
