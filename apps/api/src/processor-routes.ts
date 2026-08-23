import {
  conditionalMutationHeadersSchema,
  createProcessorRequestSchema,
  idempotentMutationHeadersSchema,
  processorDryRunRequestSchema,
  processorDryRunResponseSchema,
  processorListResponseSchema,
  processorMutationResponseSchema,
  processorResourceSchema,
  publishProcessorVersionRequestSchema,
  updateProcessorRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  ProcessorConflictError,
  ProcessorDefinitionInvalidError,
  ProcessorNotFoundError,
} from './processor-service.js';
import type { ApiDependencies } from './types.js';

const paramsSchema = z.strictObject({ id: uuidV7Schema });

function invalidParameters(
  issues: readonly ZodIssue[],
  location: 'body' | 'header' | 'path',
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
  location: 'body' | 'header' | 'path',
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

function expectedRevision(etag: string): number | undefined {
  const match = /^"processor-(0|[1-9][0-9]*)"$/.exec(etag);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function setEtag(response: Response, revision: number): void {
  response.set('etag', `"processor-${revision}"`);
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
    {
      'idempotency-key': request.get('idempotency-key'),
    },
    'header',
  );
}

function mutationHeaders(request: Request, response: Response) {
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

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerProcessorRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.processorService;
  if (service === undefined) return;

  app.get(
    '/api/v1/processors',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      sendValidated(response, processorListResponseSchema, {
        items: [...(await service.list(owner.ownerId))],
      });
    }),
  );

  app.get(
    '/api/v1/processors/:id',
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
      const processor = await service.get(owner.ownerId, params.id);
      setEtag(response, processor.configRevision);
      sendValidated(response, processorResourceSchema, processor);
    }),
  );

  app.post(
    '/api/v1/processor-versions/dry-run',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const body = parse(
        request,
        response,
        processorDryRunRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || body === undefined) return;
      sendValidated(
        response,
        processorDryRunResponseSchema,
        await service.dryRun(owner.ownerId, {
          ...(body.processorId === undefined
            ? {}
            : { processorId: body.processorId }),
          ...(body.versionId === undefined
            ? {}
            : { versionId: body.versionId }),
          definition: body.definition,
        }),
      );
    }),
  );

  app.post(
    '/api/v1/processors',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const headers = idempotencyHeaders(request, response);
      const body = parse(
        request,
        response,
        createProcessorRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || headers === undefined || body === undefined)
        return;
      const result = await service.create(
        owner.ownerId,
        body,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.processor.configRevision);
      sendValidated(
        response,
        processorMutationResponseSchema,
        {
          processor: result.processor,
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
    '/api/v1/processors/:id/versions',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      const headers = mutationHeaders(request, response);
      const body = parse(
        request,
        response,
        publishProcessorVersionRequestSchema,
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
      const revision = expectedRevision(headers['if-match']);
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid processor ETag',
        });
        return;
      }
      const result = await service.publishVersion(
        owner.ownerId,
        params.id,
        revision,
        body.versionId,
        body.definition,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.processor.configRevision);
      sendValidated(
        response,
        processorMutationResponseSchema,
        {
          processor: result.processor,
          idempotency: {
            key: headers['idempotency-key'],
            replayed: result.replayed,
          },
        },
        201,
      );
    }),
  );

  app.patch(
    '/api/v1/processors/:id',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      const headers = mutationHeaders(request, response);
      const body = parse(
        request,
        response,
        updateProcessorRequestSchema,
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
      const revision = expectedRevision(headers['if-match']);
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid processor ETag',
        });
        return;
      }
      const changes = {
        ...(body.name === undefined ? {} : { name: body.name }),
        ...(body.purpose === undefined ? {} : { purpose: body.purpose }),
        ...(body.enabled === undefined ? {} : { enabled: body.enabled }),
        ...(body.requirementMode === undefined
          ? {}
          : { requirementMode: body.requirementMode }),
        ...(body.currentVersionId === undefined
          ? {}
          : { currentVersionId: body.currentVersionId }),
      };
      const result = await service.update(
        owner.ownerId,
        params.id,
        revision,
        changes,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.processor.configRevision);
      sendValidated(response, processorMutationResponseSchema, {
        processor: result.processor,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendProcessorError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === '23505' &&
    'constraint' in error &&
    typeof error.constraint === 'string' &&
    error.constraint.startsWith('processor_')
  ) {
    sendProblem(request, response, {
      code: 'processor_conflict',
      status: 409,
      title: 'The processor identity or version already exists.',
    });
    return true;
  }
  if (error instanceof ProcessorNotFoundError) {
    sendProblem(request, response, {
      code: 'processor_not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof ProcessorConflictError) {
    sendProblem(request, response, {
      code: 'processor_conflict',
      status: 409,
      title: error.message,
    });
    return true;
  }
  if (error instanceof ProcessorDefinitionInvalidError) {
    sendProblem(request, response, {
      code: 'processor_definition_invalid',
      status: 422,
      title: error.message,
      invalidParameters: error.issues.map((entry) => ({
        name: entry.path,
        location: 'body',
        reason: entry.message,
      })),
    });
    return true;
  }
  return false;
}
