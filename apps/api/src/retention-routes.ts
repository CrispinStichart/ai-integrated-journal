import {
  browserPurgeAcknowledgementSchema,
  deletionTombstonePageSchema,
  permanentDeletionMutationResponseSchema,
  permanentDeletionPreviewRequestSchema,
  permanentDeletionPreviewSchema,
  permanentDeletionRequestSchema,
  permanentDeletionResourceSchema,
  uuidV7Schema,
} from '@journal/contracts';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import type { ApiDependencies } from './types.js';
import {
  RetentionConflictError,
  RetentionNotFoundError,
} from '@journal/database';

const idParams = z.strictObject({ id: uuidV7Schema });
const tombstoneQuery = z.strictObject({
  afterGeneration: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});

async function owner(
  request: Request,
  response: Response,
  dependencies: ApiDependencies,
  mutation = false,
) {
  const principal = await dependencies.authenticator.authenticate(request);
  if (principal === undefined) {
    sendProblem(request, response, {
      code: 'authentication_required',
      status: 401,
      title: 'Authentication required',
    });
    return undefined;
  }
  if (mutation && dependencies.authenticationService !== undefined) {
    if (!isActiveSession(principal)) {
      sendProblem(request, response, {
        code: 'forbidden',
        status: 403,
        title: 'Session authentication required',
      });
      return undefined;
    }
    dependencies.authenticationService.assertCsrf(request, principal);
  }
  return principal.ownerId;
}

export function registerRetentionRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.retentionService;
  if (service === undefined) return;
  const wrap =
    (handler: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) =>
      void handler(request, response).catch(next);

  app.post(
    '/api/v1/retention/permanent-deletions/preview',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const target = permanentDeletionPreviewRequestSchema.parse(request.body);
      sendValidated(
        response,
        permanentDeletionPreviewSchema,
        await service.preview(ownerId, {
          ...target,
          confirmation: 'PERMANENTLY DELETE',
        }),
      );
    }),
  );

  app.post(
    '/api/v1/retention/permanent-deletions',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const target = permanentDeletionRequestSchema.parse(request.body);
      const result = await service.request(
        ownerId,
        target,
        correlationId(response),
      );
      sendValidated(
        response,
        permanentDeletionMutationResponseSchema,
        result,
        result.replayed ? 200 : 202,
      );
    }),
  );

  app.get(
    '/api/v1/retention/permanent-deletions/:id',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      const { id } = idParams.parse(request.params);
      const result = await service.get(ownerId, id);
      if (result === undefined) {
        sendProblem(request, response, {
          code: 'retention_not_found',
          status: 404,
          title: 'Permanent deletion not found',
        });
        return;
      }
      sendValidated(response, permanentDeletionResourceSchema, result);
    }),
  );

  app.get(
    '/api/v1/retention/tombstones',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      const query = tombstoneQuery.parse(request.query);
      sendValidated(
        response,
        deletionTombstonePageSchema,
        await service.tombstones(ownerId, query.afterGeneration, query.limit),
      );
    }),
  );

  app.post(
    '/api/v1/retention/browser-purge-acknowledgements',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const { generation } = browserPurgeAcknowledgementSchema.parse(
        request.body,
      );
      await service.acknowledgeBrowserPurge(ownerId, generation);
      response.status(204).end();
    }),
  );
}

export function sendRetentionError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof RetentionNotFoundError) {
    sendProblem(request, response, {
      code: 'retention_not_found',
      status: 404,
      title: 'Retention target not found',
    });
  } else if (error instanceof RetentionConflictError) {
    sendProblem(request, response, {
      code: 'retention_conflict',
      status: 409,
      title: 'Permanent deletion is not currently allowed',
      detail: error.message,
    });
  } else {
    return false;
  }
  return true;
}
