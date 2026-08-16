import {
  authenticatedResponseSchema,
  authStatusResponseSchema,
  bootstrapRequestSchema,
  eventPollRequestSchema,
  eventPollResponseSchema,
  healthDetailsResponseSchema,
  lastEventIdSchema,
  livenessResponseSchema,
  logoutResponseSchema,
  passkeyOptionsResponseSchema,
  passkeyVerificationRequestSchema,
  passwordLoginRequestSchema,
  passwordRecoveryRequestSchema,
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
import { rateLimit } from 'express-rate-limit';
import { ZodError, type ZodIssue } from 'zod';

import { correlationId, sendProblem, sendValidated } from './http.js';
import {
  AuthenticationError,
  isActiveSession,
  type ActiveSession,
  type IssuedSession,
} from './auth.js';
import type {
  ApiDependencies,
  AuthenticatedPrincipal,
  HealthProbeResult,
} from './types.js';

const JSON_BODY_LIMIT = '256kb';

function issueSession(
  response: Response,
  service: NonNullable<ApiDependencies['authenticationService']>,
  session: IssuedSession,
  status = 200,
): void {
  response.setHeader('set-cookie', [
    service.sessionCookie(session.token),
    service.csrfCookie(session.csrfToken),
  ]);
  sendValidated(
    response,
    authenticatedResponseSchema,
    {
      displayName: session.displayName,
      csrfToken: session.csrfToken,
      sessionExpiresAt: session.expiresAt.toISOString(),
      ...(session.recoveryCodes === undefined
        ? {}
        : { recoveryCodes: [...session.recoveryCodes] }),
    },
    status,
  );
}

async function requireAuthSession(
  request: Request,
  response: Response,
  dependencies: ApiDependencies,
): Promise<ActiveSession | undefined> {
  const principal = await authenticate(request, response, dependencies);
  if (principal === undefined) return undefined;
  if (!isActiveSession(principal)) {
    sendProblem(request, response, {
      code: 'forbidden',
      status: 403,
      title: 'Session authentication required',
    });
    return undefined;
  }
  return principal;
}

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
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
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

  if (dependencies.authenticationService) {
    const service = dependencies.authenticationService;
    const authLimiter = rateLimit({
      windowMs: 15 * 60 * 1000,
      limit: 20,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      handler: (request, response) =>
        sendProblem(request, response, {
          code: 'rate_limited',
          status: 429,
          title: 'Too many authentication attempts',
        }),
    });
    app.use('/api/v1/auth', (_request, response, next) => {
      response.set('cache-control', 'no-store');
      next();
    });
    app.use('/api/v1/auth', authLimiter);

    app.get('/api/v1/auth/status', async (request, response) => {
      const principal = await service.authenticate(request);
      const exists = await service.ownerExists();
      sendValidated(response, authStatusResponseSchema, {
        bootstrapRequired: !exists,
        authenticated: principal !== undefined,
        ...(principal === undefined
          ? {}
          : {
              displayName: principal.displayName,
              csrfToken: principal.csrfToken,
              sessionExpiresAt: principal.expiresAt.toISOString(),
              passkeyCount: await service.passkeyCount(principal.ownerId),
            }),
      });
    });

    app.post('/api/v1/auth/bootstrap', async (request, response) => {
      const input = bootstrapRequestSchema.parse(request.body);
      issueSession(response, service, await service.bootstrap(input), 201);
    });

    app.post('/api/v1/auth/password/login', async (request, response) => {
      const input = passwordLoginRequestSchema.parse(request.body);
      issueSession(
        response,
        service,
        await service.loginWithPassword(input.password),
      );
    });

    app.post('/api/v1/auth/password/recover', async (request, response) => {
      const input = passwordRecoveryRequestSchema.parse(request.body);
      issueSession(
        response,
        service,
        await service.recover(input.recoveryCode, input.newPassword),
      );
    });

    app.post(
      '/api/v1/auth/passkeys/registration/options',
      async (request, response) => {
        const session = await requireAuthSession(
          request,
          response,
          dependencies,
        );
        if (!session) return;
        service.assertCsrf(request, session);
        sendValidated(response, passkeyOptionsResponseSchema, {
          options: await service.registrationOptions(session),
        });
      },
    );

    app.post(
      '/api/v1/auth/passkeys/registration/verify',
      async (request, response) => {
        const session = await requireAuthSession(
          request,
          response,
          dependencies,
        );
        if (!session) return;
        service.assertCsrf(request, session);
        const input = passkeyVerificationRequestSchema.parse(request.body);
        issueSession(
          response,
          service,
          await service.verifyRegistration(session, input.response),
        );
      },
    );

    app.post(
      '/api/v1/auth/passkeys/authentication/options',
      async (_request, response) => {
        sendValidated(response, passkeyOptionsResponseSchema, {
          options: await service.authenticationOptions(),
        });
      },
    );

    app.post(
      '/api/v1/auth/passkeys/authentication/verify',
      async (request, response) => {
        const input = passkeyVerificationRequestSchema.parse(request.body);
        issueSession(
          response,
          service,
          await service.loginWithPasskey(input.response),
        );
      },
    );

    app.post('/api/v1/auth/logout', async (request, response) => {
      const session = await requireAuthSession(request, response, dependencies);
      if (!session) return;
      service.assertCsrf(request, session);
      await service.logout(session);
      response.setHeader('set-cookie', service.clearCookies());
      response.set('clear-site-data', '"cache", "cookies", "storage"');
      sendValidated(response, logoutResponseSchema, { loggedOut: true });
    });
  }

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
      if (error instanceof AuthenticationError) {
        sendProblem(request, response, {
          code: error.code,
          status: error.status,
          title: error.message,
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
