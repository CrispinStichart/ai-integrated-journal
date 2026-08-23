import {
  artifactAddRequestSchema,
  artifactEditRequestSchema,
  artifactListResponseSchema,
  artifactMergeRequestSchema,
  artifactMutationResponseSchema,
  conditionalMutationHeadersSchema,
  idempotentMutationHeadersSchema,
  uuidV7Schema,
} from '@journal/contracts';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import {
  ArtifactConflictError,
  ArtifactNotFoundError,
  ArtifactPreconditionError,
} from './artifact-service.js';
import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
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
  const match = /^"artifact-(0|[1-9][0-9]*)"$/.exec(etag);
  const value = match?.[1] === undefined ? Number.NaN : Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function expectedRevisions(
  etag: string,
): Readonly<Record<string, number>> | undefined {
  const match = /^"artifacts-([^" ]+)"$/.exec(etag);
  if (match?.[1] === undefined) return undefined;
  const entries = match[1].split(',').map((item) => item.split(':'));
  const output: Record<string, number> = {};
  for (const [id, revisionText] of entries) {
    const idResult = uuidV7Schema.safeParse(id);
    const revision = Number(revisionText);
    if (!idResult.success || !Number.isSafeInteger(revision) || revision < 0)
      return undefined;
    output[idResult.data] = revision;
  }
  return output;
}

const wrap =
  (handler: (request: Request, response: Response) => Promise<void>) =>
  (request: Request, response: Response, next: NextFunction): void => {
    handler(request, response).catch(next);
  };

export function registerArtifactRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.artifactService;
  if (service === undefined) return;
  app.get(
    '/api/v1/journal-days/:id/artifacts',
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
      sendValidated(response, artifactListResponseSchema, {
        items: [...(await service.list(owner.ownerId, params.id))],
      });
    }),
  );
  app.post(
    '/api/v1/journal-days/:id/artifacts',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || params === undefined) return;
      const headers = parse(
        request,
        response,
        idempotentMutationHeadersSchema,
        { 'idempotency-key': request.get('idempotency-key') },
        'header',
      );
      const body = parse(
        request,
        response,
        artifactAddRequestSchema,
        request.body,
        'body',
      );
      if (headers === undefined || body === undefined) return;
      const result = await service.add(
        owner.ownerId,
        params.id,
        body,
        headers['idempotency-key'],
        correlationId(response),
      );
      const primary = result.artifacts[0];
      if (primary !== undefined)
        response.set('etag', `"artifact-${primary.revision}"`);
      sendValidated(
        response,
        artifactMutationResponseSchema,
        {
          artifacts: [...result.artifacts],
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
    '/api/v1/artifacts/:id/edits',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || params === undefined) return;
      if (
        request.get('idempotency-key') === undefined ||
        request.get('if-match') === undefined
      ) {
        sendProblem(request, response, {
          code: 'precondition_required',
          status: 428,
          title: 'Conditional idempotent headers required',
        });
        return;
      }
      const headers = parse(
        request,
        response,
        conditionalMutationHeadersSchema,
        {
          'idempotency-key': request.get('idempotency-key'),
          'if-match': request.get('if-match'),
        },
        'header',
      );
      const body = parse(
        request,
        response,
        artifactEditRequestSchema,
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
          title: 'Invalid artifact ETag',
        });
        return;
      }
      const result = await service.edit(
        owner.ownerId,
        params.id,
        revision,
        body,
        headers['idempotency-key'],
        correlationId(response),
      );
      const primary = result.artifacts[0];
      if (primary !== undefined)
        response.set('etag', `"artifact-${primary.revision}"`);
      sendValidated(response, artifactMutationResponseSchema, {
        artifacts: [...result.artifacts],
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
  app.post(
    '/api/v1/artifacts/merge',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      if (
        request.get('idempotency-key') === undefined ||
        request.get('if-match') === undefined
      ) {
        sendProblem(request, response, {
          code: 'precondition_required',
          status: 428,
          title: 'Conditional idempotent headers required',
        });
        return;
      }
      const headers = parse(
        request,
        response,
        idempotentMutationHeadersSchema.extend({ 'if-match': z.string() }),
        {
          'idempotency-key': request.get('idempotency-key'),
          'if-match': request.get('if-match'),
        },
        'header',
      );
      const body = parse(
        request,
        response,
        artifactMergeRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || headers === undefined || body === undefined)
        return;
      const revisions = expectedRevisions(headers['if-match']);
      if (
        revisions === undefined ||
        body.sourceArtifactIds.some((id) => revisions[id] === undefined)
      ) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid artifact-set ETag',
        });
        return;
      }
      const result = await service.merge(
        owner.ownerId,
        revisions,
        body,
        headers['idempotency-key'],
        correlationId(response),
      );
      sendValidated(response, artifactMutationResponseSchema, {
        artifacts: [...result.artifacts],
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendArtifactError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof ArtifactPreconditionError) {
    sendProblem(request, response, {
      code: 'artifact_precondition_failed',
      status: 412,
      title: error.message,
    });
    return true;
  }
  if (error instanceof ArtifactNotFoundError) {
    sendProblem(request, response, {
      code: 'artifact_not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof ArtifactConflictError) {
    sendProblem(request, response, {
      code: 'artifact_conflict',
      status: 409,
      title: error.message,
    });
    return true;
  }
  return false;
}
