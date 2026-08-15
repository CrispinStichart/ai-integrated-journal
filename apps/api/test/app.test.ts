import type { Server } from 'node:http';

import type { SseEventEnvelope } from '@journal/contracts';
import { silentLogger } from '@journal/observability';
import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApiApp } from '../src/app.js';
import { createInMemoryEventFeed } from '../src/events.js';
import type { ApiDependencies, HealthProbe } from '../src/types.js';

const CORRELATION_ID = '019c5b90-0000-7000-8000-000000000001';
const FIRST_EVENT_ID = '019c5b90-0000-7000-8000-000000000002';
const SECOND_EVENT_ID = '019c5b90-0000-7000-8000-000000000003';

function event(
  eventId: string,
  eventType = 'processing.updated',
): SseEventEnvelope {
  return {
    eventId,
    eventType,
    schemaVersion: 1,
    occurredAt: '2026-08-15T12:00:00.000Z',
    payload: { runId: 'synthetic-run' },
  };
}

function dependencies(
  overrides: Partial<ApiDependencies> = {},
): ApiDependencies {
  return {
    authenticator: {
      authenticate: async (incoming) =>
        incoming.get('authorization') === 'Bearer valid-session'
          ? { ownerId: 'owner-1' }
          : undefined,
    },
    createCorrelationId: () => CORRELATION_ID,
    eventFeed: createInMemoryEventFeed(),
    healthProbes: [],
    logger: silentLogger,
    now: () => new Date('2026-08-15T12:00:00.000Z'),
    ...overrides,
  };
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe('@journal/api operational shell', () => {
  it('API-OPS reports liveness with correlation and defensive headers', async () => {
    const response = await request(createApiApp(dependencies()))
      .get('/health/live')
      .set('x-correlation-id', CORRELATION_ID)
      .expect(200);

    expect(response.body).toEqual({ status: 'healthy' });
    expect(response.headers['x-correlation-id']).toBe(CORRELATION_ID);
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-powered-by']).toBeUndefined();
  });

  it('API-OPS reports required dependency readiness without requiring AI', async () => {
    const probes: readonly HealthProbe[] = [
      {
        name: 'postgresql',
        requiredForReadiness: true,
        check: async () => ({ status: 'healthy' }),
      },
      {
        name: 'providers',
        requiredForReadiness: false,
        check: async () => ({ status: 'unhealthy' }),
      },
    ];

    await request(createApiApp(dependencies({ healthProbes: probes })))
      .get('/health/ready')
      .expect(200, { status: 'healthy' });
  });

  it('API-OPS returns 503 when a required dependency fails', async () => {
    const healthProbes: readonly HealthProbe[] = [
      {
        name: 'storage',
        requiredForReadiness: true,
        check: async () => {
          throw new Error('synthetic failure');
        },
      },
    ];

    await request(createApiApp(dependencies({ healthProbes })))
      .get('/health/ready')
      .expect(503, { status: 'unhealthy' });
  });

  it('API-OPS protects detailed health and returns only operational detail', async () => {
    const healthProbes: readonly HealthProbe[] = [
      {
        name: 'queue',
        requiredForReadiness: false,
        check: async () => ({
          status: 'not_configured',
          detail: 'task_13',
        }),
      },
    ];
    const app = createApiApp(dependencies({ healthProbes }));

    const rejected = await request(app).get('/health/details').expect(401);
    expect(rejected.body.code).toBe('authentication_required');

    const accepted = await request(app)
      .get('/health/details')
      .set('authorization', 'Bearer valid-session')
      .expect(200);
    expect(accepted.body).toEqual({
      checkedAt: '2026-08-15T12:00:00.000Z',
      dependencies: {
        queue: { detail: 'task_13', status: 'not_configured' },
      },
      status: 'healthy',
    });
  });

  it('API-OPS validates polling requests and returns RFC 9457 errors', async () => {
    const response = await request(createApiApp(dependencies()))
      .get('/api/v1/events/poll?after=not-a-uuid')
      .set('authorization', 'Bearer valid-session')
      .expect(400);

    expect(response.type).toBe('application/problem+json');
    expect(response.body).toMatchObject({
      code: 'validation_failed',
      correlationId: CORRELATION_ID,
      status: 400,
    });
    expect(response.body.invalidParameters).toEqual([
      expect.objectContaining({ location: 'query', name: 'after' }),
    ]);
  });

  it('API-OPS polling replays only the authenticated owner events', async () => {
    const eventFeed = createInMemoryEventFeed();
    eventFeed.publish('owner-1', event(FIRST_EVENT_ID));
    eventFeed.publish('owner-2', event(SECOND_EVENT_ID));
    const response = await request(createApiApp(dependencies({ eventFeed })))
      .get('/api/v1/events/poll')
      .set('authorization', 'Bearer valid-session')
      .expect(200);

    expect(response.body).toEqual({
      events: [event(FIRST_EVENT_ID)],
      nextEventId: FIRST_EVENT_ID,
    });
  });

  it('API-OPS SSE honors Last-Event-ID and replays missed events', async () => {
    const eventFeed = createInMemoryEventFeed();
    eventFeed.publish('owner-1', event(FIRST_EVENT_ID));
    eventFeed.publish('owner-1', event(SECOND_EVENT_ID));
    const app = createApiApp(dependencies({ eventFeed }));
    const server = app.listen(0, '127.0.0.1');
    servers.push(server);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('Expected a TCP test server.');
    }
    const controller = new AbortController();
    const response = await fetch(
      `http://127.0.0.1:${address.port}/api/v1/events`,
      {
        headers: {
          authorization: 'Bearer valid-session',
          'last-event-id': FIRST_EVENT_ID,
        },
        signal: controller.signal,
      },
    );
    const reader = response.body?.getReader();
    if (reader === undefined) throw new Error('Expected an SSE response body.');
    let body = '';
    while (!body.includes(SECOND_EVENT_ID)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      body += new TextDecoder().decode(chunk.value);
    }
    controller.abort();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    expect(body).toContain(`id: ${SECOND_EVENT_ID}`);
    expect(body).not.toContain(`id: ${FIRST_EVENT_ID}`);
  });

  it('API-OPS returns correlated problem details for unknown routes', async () => {
    const response = await request(createApiApp(dependencies()))
      .get('/private-entry-text')
      .expect(404);

    expect(response.body).toMatchObject({
      code: 'not_found',
      correlationId: CORRELATION_ID,
      status: 404,
    });
  });
});
