import {
  eventPollRequestSchema,
  eventPollResponseSchema,
  healthDetailsResponseSchema,
  lastEventIdSchema,
  livenessResponseSchema,
  readinessResponseSchema,
  sseEventEnvelopeSchema,
} from '@journal/contracts';
import { createUuidV7 } from '@journal/domain';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import helmet from 'helmet';
import { ZodError, type ZodIssue } from 'zod';

import { correlationId, sendProblem, sendValidated } from './http.js';
import type {
  ApiDependencies,
  AuthenticatedPrincipal,
  HealthProbeResult,
} from './types.js';

const JSON_BODY_LIMIT = '256kb';

function invalidParameters(issues: readonly ZodIssue[]) {
  return issues.map((issue) => ({
    name: issue.path.map(String).join('.') || 'request',
    location: 'query' as const,
    reason: issue.message,
  }));
}

async function authenticate(
  request: Request,
  response: Response,
  dependencies: ApiDependencies,
): Promise<AuthenticatedPrincipal | undefined> {
  const principal = await dependencies.authenticator.authenticate(request);
  if (principal === undefined) {
    sendProblem(request, response, {
      code: 'authentication_required',
      status: 401,
      title: 'Authentication required',
    });
  }
  return principal;
}

async function runProbe(
  probe: ApiDependencies['healthProbes'][number],
  dependencies: ApiDependencies,
  requestCorrelationId: string,
): Promise<HealthProbeResult> {
  try {
    return await probe.check();
  } catch (error) {
    dependencies.logger.warn(
      {
        correlationId: requestCorrelationId,
        dependency: probe.name,
        errorType: error instanceof Error ? error.name : 'UnknownError',
      },
      'Health dependency check failed',
    );
    return { status: 'unhealthy', detail: 'check_failed' };
  }
}

function serializeSseEvent(event: unknown): string {
  const validated = sseEventEnvelopeSchema.parse(event);
  return `id: ${validated.eventId}\nevent: ${validated.eventType}\ndata: ${JSON.stringify(validated)}\n\n`;
}

export function createApiApp(dependencies: ApiDependencies): Express {
  const app = express();
  const now = dependencies.now ?? (() => new Date());
  const newCorrelationId =
    dependencies.createCorrelationId ?? (() => createUuidV7<'correlation'>());

  app.disable('x-powered-by');
  app.use(helmet());
  app.use((request, response, next) => {
    const supplied = request.get('x-correlation-id');
    const requestCorrelationId = lastEventIdSchema.safeParse(supplied).success
      ? String(supplied)
      : newCorrelationId();
    response.locals.correlationId = requestCorrelationId;
    response.set('x-correlation-id', requestCorrelationId);
    const startedAt = performance.now();
    response.once('finish', () => {
      dependencies.logger.info(
        {
          correlationId: requestCorrelationId,
          latencyMs: Math.round((performance.now() - startedAt) * 100) / 100,
          method: request.method,
          route: request.route?.path ?? 'unmatched',
          status: response.statusCode,
        },
        'HTTP request completed',
      );
    });
    next();
  });
  app.use(express.json({ limit: JSON_BODY_LIMIT, strict: true }));

  app.get('/health/live', (_request, response) => {
    sendValidated(response, livenessResponseSchema, { status: 'healthy' });
  });

  app.get('/health/ready', async (_request, response) => {
    const required = dependencies.healthProbes.filter(
      (probe) => probe.requiredForReadiness,
    );
    const results = await Promise.all(
      required.map((probe) =>
        runProbe(probe, dependencies, correlationId(response)),
      ),
    );
    const status = results.every((result) => result.status === 'healthy')
      ? 'healthy'
      : 'unhealthy';
    sendValidated(
      response,
      readinessResponseSchema,
      { status },
      status === 'healthy' ? 200 : 503,
    );
  });

  app.get('/health/details', async (request, response) => {
    const principal = await authenticate(request, response, dependencies);
    if (principal === undefined) return;
    const results = await Promise.all(
      dependencies.healthProbes.map(
        async (probe) =>
          [
            probe,
            await runProbe(probe, dependencies, correlationId(response)),
          ] as const,
      ),
    );
    const status = results.every(
      ([probe, result]) =>
        !probe.requiredForReadiness || result.status === 'healthy',
    )
      ? 'healthy'
      : 'unhealthy';
    sendValidated(
      response,
      healthDetailsResponseSchema,
      {
        checkedAt: now().toISOString(),
        dependencies: Object.fromEntries(
          results.map(([probe, result]) => [probe.name, result]),
        ),
        status,
      },
      status === 'healthy' ? 200 : 503,
    );
  });

  app.get('/api/v1/events/poll', async (request, response) => {
    const principal = await authenticate(request, response, dependencies);
    if (principal === undefined) return;
    const parsed = eventPollRequestSchema.safeParse(request.query);
    if (!parsed.success) {
      sendProblem(request, response, {
        code: 'validation_failed',
        status: 400,
        title: 'Request validation failed',
        invalidParameters: invalidParameters(parsed.error.issues),
      });
      return;
    }
    const events = await dependencies.eventFeed.poll(
      principal.ownerId,
      parsed.data.after,
    );
    const nextEventId = events.at(-1)?.eventId ?? parsed.data.after;
    sendValidated(response, eventPollResponseSchema, {
      events: [...events],
      ...(nextEventId === undefined ? {} : { nextEventId }),
    });
  });

  app.get('/api/v1/events', async (request, response) => {
    const principal = await authenticate(request, response, dependencies);
    if (principal === undefined) return;
    const parsedLastEventId = lastEventIdSchema
      .optional()
      .safeParse(request.get('last-event-id'));
    if (!parsedLastEventId.success) {
      sendProblem(request, response, {
        code: 'validation_failed',
        status: 400,
        title: 'Request validation failed',
        invalidParameters: parsedLastEventId.error.issues.map((issue) => ({
          name: 'Last-Event-ID',
          location: 'header',
          reason: issue.message,
        })),
      });
      return;
    }

    response.status(200);
    response.set({
      'cache-control': 'no-cache, no-store',
      connection: 'keep-alive',
      'content-type': 'text/event-stream; charset=utf-8',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();
    response.write('retry: 3000\n\n');

    let closed = false;
    const subscription: { unsubscribe?: () => void } = {};
    request.once('close', () => {
      closed = true;
      subscription.unsubscribe?.();
    });
    subscription.unsubscribe = await dependencies.eventFeed.watch(
      principal.ownerId,
      parsedLastEventId.data,
      (event) => {
        if (!closed) response.write(serializeSseEvent(event));
      },
    );
    if (closed) subscription.unsubscribe();

    const heartbeat = setInterval(() => {
      if (!closed) response.write(': heartbeat\n\n');
    }, dependencies.sseHeartbeatMilliseconds ?? 15_000);
    heartbeat.unref();
    request.once('close', () => clearInterval(heartbeat));
  });

  app.use((request, response) => {
    sendProblem(request, response, {
      code: 'not_found',
      status: 404,
      title: 'Resource not found',
    });
  });

  app.use(
    (
      error: unknown,
      request: Request,
      response: Response,
      next: NextFunction,
    ) => {
      void next;
      if (response.headersSent) return;
      if (error instanceof ZodError || error instanceof SyntaxError) {
        sendProblem(request, response, {
          code: 'validation_failed',
          status: 400,
          title: 'Request validation failed',
        });
        return;
      }
      dependencies.logger.error(
        {
          correlationId: correlationId(response),
          errorType: error instanceof Error ? error.name : 'UnknownError',
        },
        'Unhandled HTTP error',
      );
      sendProblem(request, response, {
        code: 'internal_error',
        status: 500,
        title: 'Internal server error',
      });
    },
  );

  return app;
}
