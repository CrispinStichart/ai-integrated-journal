import {
  createExportRequestSchema,
  exportListResponseSchema,
  exportMutationResponseSchema,
  exportResourceSchema,
  idempotentMutationHeadersSchema,
  uuidV7Schema,
} from '@journal/contracts';
import { ExportConflictError } from '@journal/database';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import type { Express, NextFunction, Request, Response } from 'express';
import { z } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import type { ApiDependencies } from './types.js';

const idParams = z.strictObject({ id: uuidV7Schema });

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

export function registerExportRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.exportService;
  if (service === undefined) return;
  const wrap =
    (handler: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) =>
      void handler(request, response).catch(next);

  app.post(
    '/api/v1/exports',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies, true);
      if (ownerId === undefined) return;
      const headers = idempotentMutationHeadersSchema.safeParse({
        'idempotency-key': request.get('idempotency-key'),
      });
      if (!headers.success) {
        sendProblem(request, response, {
          code:
            request.get('idempotency-key') === undefined
              ? 'precondition_required'
              : 'invalid_request',
          status: request.get('idempotency-key') === undefined ? 428 : 400,
          title:
            request.get('idempotency-key') === undefined
              ? 'Idempotency-Key is required'
              : 'Idempotency-Key is invalid',
        });
        return;
      }
      let created: Awaited<ReturnType<typeof service.create>>;
      try {
        created = await service.create(
          ownerId,
          createExportRequestSchema.parse(request.body),
          headers.data['idempotency-key'],
          correlationId(response),
        );
      } catch (error) {
        if (!(error instanceof ExportConflictError)) throw error;
        sendProblem(request, response, {
          code: 'idempotency_conflict',
          status: 409,
          title: 'Idempotency key conflict',
          detail: error.message,
        });
        return;
      }
      sendValidated(
        response,
        exportMutationResponseSchema,
        {
          export: created.export,
          idempotency: {
            key: headers.data['idempotency-key'],
            replayed: created.replayed,
          },
        },
        created.replayed ? 200 : 202,
      );
    }),
  );

  app.get(
    '/api/v1/exports',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      sendValidated(response, exportListResponseSchema, {
        items: await service.list(ownerId),
      });
    }),
  );

  app.get(
    '/api/v1/exports/:id',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      const { id } = idParams.parse(request.params);
      const item = await service.get(ownerId, id);
      if (item === undefined) {
        sendProblem(request, response, {
          code: 'export_not_found',
          status: 404,
          title: 'Export not found',
        });
        return;
      }
      sendValidated(response, exportResourceSchema, item);
    }),
  );

  app.get(
    '/api/v1/exports/:id/download',
    wrap(async (request, response) => {
      const ownerId = await owner(request, response, dependencies);
      if (ownerId === undefined) return;
      const { id } = idParams.parse(request.params);
      const download = await service.download(
        ownerId,
        id,
        correlationId(response),
      );
      if (download === undefined) {
        sendProblem(request, response, {
          code: 'export_download_unavailable',
          status: 409,
          title: 'Export download unavailable',
          detail: 'The archive is incomplete, expired, or invalidated.',
        });
        return;
      }
      response.set({
        'cache-control': 'private, no-store',
        'content-disposition': `attachment; filename="journal-export-${id}.zip"`,
        'content-length': download.byteSize.toString(),
        'content-type': 'application/zip',
        'x-content-sha256': download.sha256,
      });
      const reader = download.body.getReader();
      const source = Readable.from(
        (async function* () {
          try {
            for (;;) {
              const result = await reader.read();
              if (result.done) return;
              yield result.value;
            }
          } finally {
            reader.releaseLock();
          }
        })(),
      );
      await pipeline(source, response);
    }),
  );
}
