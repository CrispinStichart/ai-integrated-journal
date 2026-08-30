import {
  conditionalMutationHeadersSchema,
  providerSettingsMutationResponseSchema,
  settingsMutationResponseSchema,
  settingsResourceSchema,
  updateProviderSettingsRequestSchema,
  updateSettingsRequestSchema,
} from '@journal/contracts';
import {
  SettingsConflictError,
  SettingsNotFoundError,
} from '@journal/database';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import { SettingsValidationError } from './settings-service.js';
import type { ApiDependencies } from './types.js';

const providerParamsSchema = z.strictObject({
  providerId: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
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

function mutationHeaders(request: Request, response: Response) {
  const parsed = conditionalMutationHeadersSchema.safeParse({
    'idempotency-key': request.get('idempotency-key'),
    'if-match': request.get('if-match'),
  });
  if (!parsed.success) {
    sendProblem(request, response, {
      code: 'precondition_required',
      status: 428,
      title: 'Conditional idempotent headers required',
    });
    return undefined;
  }
  const match = /^"settings-([1-9][0-9]*)"$/.exec(parsed.data['if-match']);
  if (match === null) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: 'Settings ETag is invalid',
    });
    return undefined;
  }
  return {
    idempotencyKey: parsed.data['idempotency-key'],
    expectedRevision: Number(match[1]),
  };
}

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerSettingsRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.settingsService;
  if (service === undefined) return;
  app.use('/api/v1/settings', (_request, response, next) => {
    response.set('cache-control', 'no-store');
    next();
  });

  app.get(
    '/api/v1/settings',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      const settings = await service.get(ownerId);
      response.set('etag', `"settings-${String(settings.revision)}"`);
      sendValidated(response, settingsResourceSchema, settings);
    }),
  );

  app.put(
    '/api/v1/settings',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const headers = mutationHeaders(request, response);
      if (headers === undefined) return;
      const input = updateSettingsRequestSchema.parse(request.body);
      const result = await service.update(
        ownerId,
        headers.expectedRevision,
        input,
        headers.idempotencyKey,
        correlationId(response),
      );
      response.set('etag', `"settings-${String(result.settings.revision)}"`);
      sendValidated(response, settingsMutationResponseSchema, {
        settings: result.settings,
        idempotency: {
          key: headers.idempotencyKey,
          replayed: result.replayed,
        },
      });
    }),
  );

  app.put(
    '/api/v1/settings/providers/:providerId',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const headers = mutationHeaders(request, response);
      if (headers === undefined) return;
      const { providerId } = providerParamsSchema.parse(request.params);
      const input = updateProviderSettingsRequestSchema.parse(request.body);
      const result = await service.updateProvider(
        ownerId,
        providerId,
        headers.expectedRevision,
        input,
        headers.idempotencyKey,
        correlationId(response),
      );
      sendValidated(response, providerSettingsMutationResponseSchema, {
        provider: result.provider,
        idempotency: {
          key: headers.idempotencyKey,
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendSettingsError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof SettingsNotFoundError) {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: 'Settings not found',
    });
  } else if (error instanceof SettingsConflictError) {
    sendProblem(request, response, {
      code: 'etag_mismatch',
      status: 409,
      title: 'Settings changed in another session',
      detail: error.message,
    });
  } else if (error instanceof SettingsValidationError) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: 'Settings validation failed',
      detail: error.message,
    });
  } else {
    return false;
  }
  return true;
}
