import {
  conditionalMutationHeadersSchema,
  editCorrectedTranscriptRequestSchema,
  recordingTranscriptInspectorSchema,
  transcriptMutationResponseSchema,
  transcriptRevisionHistorySchema,
  uuidV7Schema,
} from '@journal/contracts';
import {
  TranscriptCleanupStateError,
  TranscriptRevisionConflictError,
} from '@journal/database';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  TranscriptConflictError,
  TranscriptNotFoundError,
  TranscriptRetryUnavailableError,
} from './transcript-service.js';
import type { ApiDependencies } from './types.js';

const paramsSchema = z.strictObject({ id: uuidV7Schema });

function invalidParameters(
  issues: readonly ZodIssue[],
  location: 'body' | 'header' | 'path',
) {
  return issues.map((issue) => ({
    name: issue.path.map(String).join('.') || 'request',
    location,
    reason: issue.message,
  }));
}

function parse<T>(
  request: Request,
  response: Response,
  schema: z.ZodType<T>,
  value: unknown,
  location: 'body' | 'header' | 'path',
): T | undefined {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  sendProblem(request, response, {
    code: 'validation_failed',
    status: 400,
    title: 'Request validation failed',
    invalidParameters: invalidParameters(result.error.issues, location),
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
  const match = /^"revision-(0|[1-9][0-9]*)"$/.exec(etag);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function setEtag(response: Response, revision: number | undefined): void {
  if (revision !== undefined) response.set('etag', `"revision-${revision}"`);
}

function mutationHeaders(request: Request, response: Response) {
  if (request.get('idempotency-key') === undefined) {
    sendProblem(request, response, {
      code: 'idempotency_key_required',
      status: 428,
      title: 'Idempotency-Key header required',
    });
    return undefined;
  }
  if (request.get('if-match') === undefined) {
    sendProblem(request, response, {
      code: 'precondition_required',
      status: 428,
      title: 'If-Match header required',
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
  (
    handler: (request: Request, response: Response) => Promise<void>,
  ): ((request: Request, response: Response, next: NextFunction) => void) =>
  (request, response, next) => {
    handler(request, response).catch(next);
  };

export function registerTranscriptRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.transcriptService;
  if (service === undefined) return;

  app.get(
    '/api/v1/recordings/:id/transcripts',
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
      const inspector = await service.inspect(owner.ownerId, params.id);
      setEtag(
        response,
        inspector.corrected?.currentRevision.revision ??
          inspector.rawStt?.currentRevision.revision,
      );
      sendValidated(response, recordingTranscriptInspectorSchema, inspector);
    }),
  );

  app.get(
    '/api/v1/transcripts/:id/revisions',
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
      sendValidated(response, transcriptRevisionHistorySchema, {
        items: [...(await service.history(owner.ownerId, params.id))],
      });
    }),
  );

  app.patch(
    '/api/v1/transcripts/:id',
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
      const input = parse(
        request,
        response,
        editCorrectedTranscriptRequestSchema,
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
      const revision = expectedRevision(headers['if-match']);
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid transcript ETag',
        });
        return;
      }
      const result = await service.editCorrected(
        owner.ownerId,
        params.id,
        revision,
        input.text,
        input.editReason,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.inspector.corrected?.currentRevision.revision);
      sendValidated(response, transcriptMutationResponseSchema, {
        inspector: result.inspector,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );

  app.post(
    '/api/v1/transcripts/:id/cleanup/retry',
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
      if (owner === undefined || params === undefined || headers === undefined)
        return;
      const revision = expectedRevision(headers['if-match']);
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid transcript ETag',
        });
        return;
      }
      const result = await service.retryCleanup(
        owner.ownerId,
        params.id,
        revision,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.inspector.corrected?.currentRevision.revision);
      sendValidated(response, transcriptMutationResponseSchema, {
        inspector: result.inspector,
        idempotency: {
          key: headers['idempotency-key'],
          replayed: result.replayed,
        },
      });
    }),
  );
}

export function sendTranscriptError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof TranscriptNotFoundError) {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (
    error instanceof TranscriptConflictError ||
    error instanceof TranscriptRevisionConflictError
  ) {
    sendProblem(request, response, {
      code: 'etag_mismatch',
      status: 412,
      title: error.message,
    });
    return true;
  }
  if (
    error instanceof TranscriptRetryUnavailableError ||
    error instanceof TranscriptCleanupStateError
  ) {
    sendProblem(request, response, {
      code: 'retry_unavailable',
      status: 409,
      title: error.message,
    });
    return true;
  }
  return false;
}
