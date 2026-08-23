import { once } from 'node:events';

import {
  MAX_AUDIO_CHUNK_BYTES,
  MAX_AUDIO_RANGE_BYTES,
  audioDeletionResponseSchema,
  createRecordingRequestSchema,
  finalizeRecordingRequestSchema,
  idempotentMutationHeadersSchema,
  recordingChunkUploadResponseSchema,
  recordingMutationResponseSchema,
  recordingUploadStatusSchema,
  sha256Schema,
  uuidV7Schema,
} from '@journal/contracts';
import { BlobRangeNotSatisfiableError } from '@journal/storage';
import type { Express, NextFunction, Request, Response } from 'express';
import { z, type ZodIssue } from 'zod';

import { isActiveSession } from './auth.js';
import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  RecordingAudioDeletedError,
  RecordingConflictError,
  RecordingNotDurableError,
  RecordingNotFoundError,
} from './recording-service.js';
import type { ApiDependencies } from './types.js';

const paramsSchema = z.strictObject({ id: uuidV7Schema });
const chunkParamsSchema = z.strictObject({
  id: uuidV7Schema,
  index: z.coerce.number().int().nonnegative().max(2_147_483_647),
});
const uploadQuerySchema = z.strictObject({
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(1_000).default(1_000),
});

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
    invalidParameters: invalidParameters(result.error.issues, location),
  });
  return undefined;
}

function idempotencyKey(
  request: Request,
  response: Response,
): string | undefined {
  const result = idempotentMutationHeadersSchema.safeParse({
    'idempotency-key': request.get('idempotency-key'),
  });
  if (result.success) return result.data['idempotency-key'];
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
    invalidParameters: invalidParameters(result.error.issues, 'header'),
  });
  return undefined;
}

function parseRange(
  value: string | undefined,
  total: bigint,
): { start: bigint; endExclusive: bigint } {
  if (total === 0n) return { start: 0n, endExclusive: 0n };
  if (value === undefined) {
    const endExclusive =
      total < BigInt(MAX_AUDIO_RANGE_BYTES)
        ? total
        : BigInt(MAX_AUDIO_RANGE_BYTES);
    return { start: 0n, endExclusive };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (match === null || (match[1] === '' && match[2] === ''))
    throw new BlobRangeNotSatisfiableError();
  let start: bigint;
  let endExclusive: bigint;
  if (match[1] === '') {
    const suffix = BigInt(match[2] ?? '0');
    if (suffix === 0n) throw new BlobRangeNotSatisfiableError();
    start = suffix >= total ? 0n : total - suffix;
    endExclusive = total;
  } else {
    start = BigInt(match[1] ?? '0');
    const inclusiveEnd = match[2] === '' ? total - 1n : BigInt(match[2] ?? '0');
    if (inclusiveEnd < start || start >= total)
      throw new BlobRangeNotSatisfiableError();
    endExclusive = inclusiveEnd >= total ? total : inclusiveEnd + 1n;
  }
  if (endExclusive - start > BigInt(MAX_AUDIO_RANGE_BYTES))
    throw new BlobRangeNotSatisfiableError();
  return { start, endExclusive };
}

export function registerRecordingRoutes(
  app: Express,
  dependencies: ApiDependencies,
): void {
  const service = dependencies.recordingService;
  if (service === undefined) return;
  const wrap =
    (handler: (request: Request, response: Response) => Promise<void>) =>
    (request: Request, response: Response, next: NextFunction) =>
      void handler(request, response).catch(next);

  app.post(
    '/api/v1/recordings',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const input = parse(
        request,
        response,
        createRecordingRequestSchema,
        request.body,
        'body',
      );
      if (owner === undefined || key === undefined || input === undefined)
        return;
      const result = await service.create(
        owner.ownerId,
        input,
        key,
        correlationId(response),
      );
      sendValidated(
        response,
        recordingMutationResponseSchema,
        {
          recording: result.recording,
          idempotency: { key, replayed: result.replayed },
        },
        result.replayed ? 200 : 201,
      );
    }),
  );

  app.put(
    '/api/v1/recordings/:id/chunks/:index',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        chunkParamsSchema,
        request.params,
        'path',
      );
      const checksum = parse(
        request,
        response,
        sha256Schema,
        request.get('x-content-sha256'),
        'header',
      );
      if (
        owner === undefined ||
        key === undefined ||
        params === undefined ||
        checksum === undefined
      )
        return;
      const declared = request.get('content-length');
      if (
        declared !== undefined &&
        (!/^\d+$/.test(declared) ||
          BigInt(declared) > BigInt(MAX_AUDIO_CHUNK_BYTES))
      ) {
        sendProblem(request, response, {
          code: 'payload_too_large',
          status: 413,
          title: 'Audio chunk exceeds 8 MiB',
        });
        return;
      }
      const body = (async function* () {
        for await (const value of request)
          yield new Uint8Array(value as Buffer);
      })();
      const result = await service.uploadChunk(
        owner.ownerId,
        params.id,
        params.index,
        checksum,
        key,
        body,
      );
      sendValidated(
        response,
        recordingChunkUploadResponseSchema,
        {
          chunk: {
            index: result.index,
            byteSize: result.byteSize,
            sha256: result.sha256,
          },
          replayed: result.replayed,
        },
        result.replayed ? 200 : 201,
      );
    }),
  );

  app.get(
    '/api/v1/recordings/:id/upload',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      const query = parse(
        request,
        response,
        uploadQuerySchema,
        request.query,
        'query',
      );
      if (owner === undefined || params === undefined || query === undefined)
        return;
      const upload = await service.getUpload(
        owner.ownerId,
        params.id,
        query.after,
        query.limit,
      );
      sendValidated(response, recordingUploadStatusSchema, {
        ...upload,
        acceptedIndexes: [...upload.acceptedIndexes],
      });
    }),
  );

  app.post(
    '/api/v1/recordings/:id/finalize',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      const input = parse(
        request,
        response,
        finalizeRecordingRequestSchema,
        request.body,
        'body',
      );
      if (
        owner === undefined ||
        key === undefined ||
        params === undefined ||
        input === undefined
      )
        return;
      const result = await service.finalize(
        owner.ownerId,
        params.id,
        input,
        key,
      );
      sendValidated(response, recordingMutationResponseSchema, {
        recording: result.recording,
        idempotency: { key, replayed: result.replayed },
      });
    }),
  );

  app.post(
    '/api/v1/recordings/:id/retry',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || key === undefined || params === undefined)
        return;
      const result = await service.retry(owner.ownerId, params.id, key);
      sendValidated(response, recordingMutationResponseSchema, {
        recording: result.recording,
        idempotency: { key, replayed: result.replayed },
      });
    }),
  );

  app.post(
    '/api/v1/recordings/:id/transcription/retry',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (key === undefined || params === undefined) return;
      const result = await service.retryTranscription(
        owner.ownerId,
        params.id,
        key,
      );
      sendValidated(response, recordingMutationResponseSchema, {
        recording: result.recording,
        idempotency: { key, replayed: result.replayed },
      });
    }),
  );

  app.get(
    '/api/v1/recordings/:id/audio',
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
      const status = await service.getUpload(
        owner.ownerId,
        params.id,
        undefined,
        1,
      );
      const total =
        status.recording.byteSize === undefined
          ? 0n
          : BigInt(status.recording.byteSize);
      const range = parseRange(request.get('range'), total);
      const opened = await service.openAudio(owner.ownerId, params.id, range);
      response.status(total === 0n ? 200 : 206);
      response.set({
        'accept-ranges': 'bytes',
        'cache-control': 'private, no-store',
        'content-length': String(range.endExclusive - range.start),
        'content-type': opened.recording.mimeType,
        ...(total === 0n
          ? {}
          : {
              'content-range': `bytes ${String(range.start)}-${String(range.endExclusive - 1n)}/${String(total)}`,
            }),
      });
      for await (const bytes of opened.stream) {
        if (!response.write(bytes)) await once(response, 'drain');
      }
      response.end();
    }),
  );

  app.delete(
    '/api/v1/recordings/:id/audio',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || key === undefined || params === undefined)
        return;
      const result = await service.deleteAudio(
        owner.ownerId,
        params.id,
        key,
        correlationId(response),
      );
      sendValidated(response, audioDeletionResponseSchema, {
        recording: result.recording,
        warning: result.warning,
        idempotency: { key, replayed: result.replayed },
      });
    }),
  );

  app.post(
    '/api/v1/recordings/:id/audio/restore',
    wrap(async (request, response) => {
      const owner = await principal(request, response, dependencies, true);
      if (owner === undefined) return;
      const key = idempotencyKey(request, response);
      const params = parse(
        request,
        response,
        paramsSchema,
        request.params,
        'path',
      );
      if (owner === undefined || key === undefined || params === undefined)
        return;
      const result = await service.restoreAudio(
        owner.ownerId,
        params.id,
        key,
        correlationId(response),
      );
      sendValidated(response, recordingMutationResponseSchema, {
        recording: result.recording,
        idempotency: { key, replayed: result.replayed },
      });
    }),
  );
}

export function sendRecordingError(
  error: unknown,
  request: Request,
  response: Response,
): boolean {
  if (error instanceof RecordingNotFoundError) {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: error.message,
    });
    return true;
  }
  if (error instanceof RecordingConflictError) {
    sendProblem(request, response, {
      code: 'conflict',
      status: 409,
      title: error.message,
    });
    return true;
  }
  if (error instanceof RecordingAudioDeletedError) {
    sendProblem(request, response, {
      code: 'audio_deleted',
      status: 410,
      title: error.message,
    });
    return true;
  }
  if (error instanceof RecordingNotDurableError) {
    sendProblem(request, response, {
      code: 'recording_not_durable',
      status: 409,
      title: error.message,
    });
    return true;
  }
  if (error instanceof BlobRangeNotSatisfiableError) {
    response.set('content-range', 'bytes */*');
    sendProblem(request, response, {
      code: 'range_not_satisfiable',
      status: 416,
      title: error.message,
    });
    return true;
  }
  if (error instanceof RangeError) {
    sendProblem(request, response, {
      code: 'payload_too_large',
      status: 413,
      title: error.message,
    });
    return true;
  }
  if (error instanceof Error && 'code' in error && error.code === 'ENOSPC') {
    sendProblem(request, response, {
      code: 'server_storage_exhausted',
      status: 507,
      title: 'Server storage is exhausted',
    });
    return true;
  }
  return false;
}
