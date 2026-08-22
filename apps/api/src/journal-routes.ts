import {
  conditionalMutationHeadersSchema,
  contributionMutationResponseSchema,
  contributionRevisionPageSchema,
  contributionSchema,
  createContributionRequestSchema,
  cursorPaginationRequestSchema,
  editContributionRequestSchema,
  idempotentMutationHeadersSchema,
  journalDateSchema,
  journalDaySummaryPageSchema,
  journalDayViewSchema,
  moveContributionRequestSchema,
  uuidV7Schema,
} from '@journal/contracts';
import {
  DeletedContributionError,
  JournalRecordNotFoundError,
} from '@journal/database';
import {
  DomainInvariantError,
  OptimisticConcurrencyError,
} from '@journal/domain';
import {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  IdempotencyConflictError,
  InvalidJournalCursorError,
} from './journal-service.js';
import type { ApiDependencies } from './types.js';

const includeDeletedSchema = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value === 'true');

function invalidParameters(
  issues: readonly ZodIssue[],
  location: 'body' | 'header' | 'path' | 'query',
) {
  return issues.map((issue) => ({
    name: issue.path.map(String).join('.') || 'request',
    location,
    reason: issue.message,
  }));
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

function parseParams(request: Request, response: Response, schema: z.ZodType) {
  const parsed = schema.safeParse(request.params);
  if (!parsed.success) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: 'Request validation failed',
      invalidParameters: invalidParameters(parsed.error.issues, 'path'),
    });
    return undefined;
  }
  return parsed.data as Record<string, string>;
}

function parseQuery(request: Request, response: Response, schema: z.ZodType) {
  const parsed = schema.safeParse(request.query);
  if (!parsed.success) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: 'Request validation failed',
      invalidParameters: invalidParameters(parsed.error.issues, 'query'),
    });
    return undefined;
  }
  return parsed.data;
}

function mutationHeaders(
  request: Request,
  response: Response,
  conditional: boolean,
) {
  const schema = conditional
    ? conditionalMutationHeadersSchema
    : idempotentMutationHeadersSchema;
  const value = conditional
    ? {
        'idempotency-key': request.get('idempotency-key'),
        'if-match': request.get('if-match'),
      }
    : { 'idempotency-key': request.get('idempotency-key') };
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    const missingIdempotency = request.get('idempotency-key') === undefined;
    const missingPrecondition =
      conditional && request.get('if-match') === undefined;
    sendProblem(request, response, {
      code: missingIdempotency
        ? 'idempotency_key_required'
        : missingPrecondition
          ? 'precondition_required'
          : 'validation_failed',
      status: missingIdempotency || missingPrecondition ? 428 : 400,
      title: missingIdempotency
        ? 'Idempotency-Key is required'
        : missingPrecondition
          ? 'If-Match is required'
          : 'Request validation failed',
      invalidParameters: invalidParameters(parsed.error.issues, 'header'),
    });
    return undefined;
  }
  return parsed.data;
}

function expectedRevision(etag: string): number | undefined {
  const match = /^"revision-(0|[1-9][0-9]*)"$/.exec(etag);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function setEtag(response: Response, revision: number | undefined) {
  if (revision !== undefined) response.set('etag', `"revision-${revision}"`);
}

export function registerJournalRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.journalService;
  if (service === undefined) return;
  const wrap =
    (handler: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) =>
      void handler(request, response).catch(next);

  app.get(
    '/api/v1/journal-days',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      const query = parseQuery(
        request,
        response,
        cursorPaginationRequestSchema,
      );
      if (query === undefined) return;
      const page = await service.listDays(
        owner.ownerId,
        query as { limit: number; cursor?: string },
      );
      sendValidated(response, journalDaySummaryPageSchema, {
        items: [...page.items],
        page: {
          hasMore: page.hasMore,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        },
      });
    }),
  );

  app.get(
    '/api/v1/journal-days/:date',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      const params = parseParams(
        request,
        response,
        z.strictObject({ date: journalDateSchema }),
      );
      const includeDeleted = parseQuery(
        request,
        response,
        z.strictObject({ includeDeleted: includeDeletedSchema }),
      );
      if (params === undefined || includeDeleted === undefined) return;
      const day = await service.getDay(
        owner.ownerId,
        params.date ?? '',
        (includeDeleted as { includeDeleted: boolean }).includeDeleted,
      );
      if (day === undefined) {
        sendProblem(request, response, {
          code: 'not_found',
          status: 404,
          title: 'Journal day not found',
        });
        return;
      }
      sendValidated(response, journalDayViewSchema, day);
    }),
  );

  app.get(
    '/api/v1/contributions/:id',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      const params = parseParams(
        request,
        response,
        z.strictObject({ id: uuidV7Schema }),
      );
      const query = parseQuery(
        request,
        response,
        z.strictObject({ includeDeleted: includeDeletedSchema }),
      );
      if (params === undefined || query === undefined) return;
      const contribution = await service.getContribution(
        owner.ownerId,
        params.id ?? '',
        (query as { includeDeleted: boolean }).includeDeleted,
      );
      if (contribution === undefined) {
        sendProblem(request, response, {
          code: 'not_found',
          status: 404,
          title: 'Contribution not found',
        });
        return;
      }
      setEtag(response, contribution.currentRevision?.revision ?? 0);
      sendValidated(response, contributionSchema, contribution);
    }),
  );

  app.get(
    '/api/v1/contributions/:id/revisions',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      if (owner === undefined) return;
      const params = parseParams(
        request,
        response,
        z.strictObject({ id: uuidV7Schema }),
      );
      const query = parseQuery(
        request,
        response,
        cursorPaginationRequestSchema,
      );
      if (params === undefined || query === undefined) return;
      const page = await service.listRevisions(
        owner.ownerId,
        params.id ?? '',
        query as { limit: number; cursor?: string },
      );
      if (
        page.items.length === 0 &&
        (await service.getContribution(
          owner.ownerId,
          params.id ?? '',
          true,
        )) === undefined
      ) {
        sendProblem(request, response, {
          code: 'not_found',
          status: 404,
          title: 'Contribution not found',
        });
        return;
      }
      sendValidated(response, contributionRevisionPageSchema, {
        items: [...page.items],
        page: {
          hasMore: page.hasMore,
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        },
      });
    }),
  );

  app.post(
    '/api/v1/contributions',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const headers = mutationHeaders(request, response, false);
      if (headers === undefined) return;
      const input = createContributionRequestSchema.parse(request.body);
      const result = await service.create(
        owner.ownerId,
        input,
        headers['idempotency-key'],
        correlationId(response),
      );
      setEtag(response, result.contribution.currentRevision?.revision ?? 0);
      sendValidated(
        response,
        contributionMutationResponseSchema,
        {
          contribution: result.contribution,
          idempotency: {
            key: headers['idempotency-key'],
            replayed: result.replayed,
          },
        },
        result.replayed ? 200 : 201,
      );
    }),
  );

  const conditionalMutation = (
    operation: 'edit' | 'move' | 'delete' | 'restore',
  ) =>
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const params = parseParams(
        request,
        response,
        z.strictObject({ id: uuidV7Schema }),
      );
      const headers = mutationHeaders(request, response, true);
      if (
        params === undefined ||
        headers === undefined ||
        !('if-match' in headers)
      )
        return;
      const revision = expectedRevision(String(headers['if-match']));
      if (revision === undefined) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Invalid contribution ETag',
          invalidParameters: [
            {
              name: 'if-match',
              location: 'header',
              reason: 'Expected an ETag in the form "revision-N".',
            },
          ],
        });
        return;
      }
      const id = params.id ?? '';
      const key = String(headers['idempotency-key']);
      const result =
        operation === 'edit'
          ? await service.edit(
              owner.ownerId,
              id,
              editContributionRequestSchema.parse(request.body),
              revision,
              key,
              correlationId(response),
            )
          : operation === 'move'
            ? await service.move(
                owner.ownerId,
                id,
                moveContributionRequestSchema.parse(request.body),
                revision,
                key,
                correlationId(response),
              )
            : operation === 'delete'
              ? await service.delete(
                  owner.ownerId,
                  id,
                  revision,
                  key,
                  correlationId(response),
                )
              : await service.restore(
                  owner.ownerId,
                  id,
                  revision,
                  key,
                  correlationId(response),
                );
      setEtag(response, result.contribution.currentRevision?.revision ?? 0);
      sendValidated(response, contributionMutationResponseSchema, {
        contribution: result.contribution,
        idempotency: { key, replayed: result.replayed },
      });
    });
  app.patch('/api/v1/contributions/:id', conditionalMutation('edit'));
  app.post('/api/v1/contributions/:id/move', conditionalMutation('move'));
  app.delete('/api/v1/contributions/:id', conditionalMutation('delete'));
  app.post('/api/v1/contributions/:id/restore', conditionalMutation('restore'));
}

export function sendJournalError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof JournalRecordNotFoundError) {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: 'Contribution not found',
    });
  } else if (error instanceof OptimisticConcurrencyError) {
    sendProblem(request, response, {
      code: 'etag_mismatch',
      status: 412,
      title: 'Contribution changed',
      detail: `Expected revision ${error.expectedVersion}; current revision is ${error.actualVersion}.`,
    });
  } else if (error instanceof IdempotencyConflictError) {
    sendProblem(request, response, {
      code: 'idempotency_key_reused',
      status: 409,
      title: 'Idempotency key reused with different input',
    });
  } else if (error instanceof DeletedContributionError) {
    sendProblem(request, response, {
      code: 'conflict',
      status: 409,
      title: 'Contribution is deleted',
    });
  } else if (
    error instanceof InvalidJournalCursorError ||
    error instanceof DomainInvariantError
  ) {
    sendProblem(request, response, {
      code: 'validation_failed',
      status: 400,
      title: 'Request validation failed',
    });
  } else {
    return false;
  }
  return true;
}
