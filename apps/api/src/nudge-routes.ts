import {
  conditionalMutationHeadersSchema,
  idempotencyResponseMetadataSchema,
  nudgeActionRequestSchema,
  nudgeDayQuerySchema,
  nudgeDayResourceSchema,
  nudgeMutationResponseSchema,
  nudgePreferenceMutationResponseSchema,
  nudgePreferenceSchema,
  updateNudgePreferenceRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import { DomainInvariantError } from '@journal/domain';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import type { ApiDependencies } from './types.js';
import {
  NudgeConflictError,
  NudgeNotFoundError,
  NudgeStateError,
} from '@journal/database';

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

function expectedRevision(etag: string, kind: 'nudge' | 'nudge-preferences') {
  const match = new RegExp(`^"${kind}-([1-9][0-9]*)"$`).exec(etag);
  const revision = Number(match?.[1]);
  return Number.isSafeInteger(revision) && revision > 0 ? revision : undefined;
}

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerNudgeRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.nudgeService;
  if (service === undefined) return;

  app.get(
    '/api/v1/nudges',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      const query = parse(
        request,
        response,
        nudgeDayQuerySchema,
        request.query,
        'query',
      );
      if (owner === undefined || query === undefined) return;
      const day = await service.getDay(owner.ownerId, query.journalDate);
      if (day.digest !== undefined)
        response.set('etag', `"nudge-${day.digest.revision}"`);
      sendValidated(response, nudgeDayResourceSchema, day);
    }),
  );

  app.post(
    '/api/v1/nudges/:id/actions',
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
      const body = parse(
        request,
        response,
        nudgeActionRequestSchema,
        request.body,
        'body',
      );
      if (
        owner === undefined ||
        params === undefined ||
        headers === undefined ||
        body === undefined
      )
        return;
      const revision = expectedRevision(headers['if-match'], 'nudge');
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid nudge ETag',
        });
        return;
      }
      const result = await service.act(
        owner.ownerId,
        params.id,
        revision,
        body,
        headers['idempotency-key'],
        correlationId(response),
      );
      if (result.day.digest !== undefined)
        response.set('etag', `"nudge-${result.day.digest.revision}"`);
      sendValidated(response, nudgeMutationResponseSchema, {
        day: result.day,
        responseContributionId: result.responseContributionId,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );

  app.get(
    '/api/v1/nudges/preferences',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      const preference = await service.getPreferences(owner.ownerId);
      response.set('etag', `"nudge-preferences-${preference.revision}"`);
      sendValidated(response, nudgePreferenceSchema, preference);
    }),
  );

  app.put(
    '/api/v1/nudges/preferences',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const headers = conditionalHeaders(request, response);
      const body = parse(
        request,
        response,
        updateNudgePreferenceRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || headers === undefined || body === undefined)
        return;
      const revision = expectedRevision(
        headers['if-match'],
        'nudge-preferences',
      );
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid nudge preference ETag',
        });
        return;
      }
      const result = await service.updatePreferences(
        owner.ownerId,
        revision,
        body,
        headers['idempotency-key'],
      );
      response.set('etag', `"nudge-preferences-${result.preference.revision}"`);
      sendValidated(response, nudgePreferenceMutationResponseSchema, {
        preference: result.preference,
        idempotency: idempotencyResponseMetadataSchema.parse({
          key: headers['idempotency-key'],
          replayed: result.replayed,
        }),
      });
    }),
  );
}

export function sendNudgeError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof NudgeNotFoundError) {
    sendProblem(request, response, {
      code: 'nudge_not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof NudgeConflictError) {
    sendProblem(request, response, {
      code: 'nudge_conflict',
      status: 409,
      title: error.message,
    });
    return true;
  }
  if (
    error instanceof NudgeStateError ||
    error instanceof DomainInvariantError
  ) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: error.message,
    });
    return true;
  }
  return false;
}
