import { assertQueueFoundation, type DatabaseClient } from '@journal/database';
import { silentLogger } from '@journal/observability';
import type { PgBoss } from 'pg-boss';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@journal/database', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@journal/database')>()),
  assertQueueFoundation: vi.fn(),
}));

import { getWorkerStatus, WorkerRuntime } from '../src/worker.js';

describe('@journal/worker operational shell', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports its declared package dependency and lifecycle state', () => {
    expect(getWorkerStatus()).toEqual({
      dependencies: ['@journal/processors'],
      service: '@journal/worker',
      status: 'ready',
    });
  });

  it('checks compatibility, starts consumers once, and shuts resources down once', async () => {
    const boss = {
      start: vi.fn(),
      stop: vi.fn(),
    } as unknown as PgBoss;
    const database = {
      close: vi.fn(),
    } as unknown as DatabaseClient;
    const registerConsumers = vi.fn();
    const runtime = new WorkerRuntime({
      boss,
      database,
      logger: silentLogger,
      registerConsumers,
      shutdownGraceMilliseconds: 25,
    });

    expect(runtime.getStatus().status).toBe('stopped');
    await runtime.start();
    await runtime.start();
    expect(runtime.getStatus().status).toBe('ready');
    expect(assertQueueFoundation).toHaveBeenCalledOnce();
    expect(boss.start).toHaveBeenCalledOnce();
    expect(registerConsumers).toHaveBeenCalledOnce();

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    await Promise.all([firstStop, secondStop]);
    expect(runtime.getStatus().status).toBe('stopped');
    expect(boss.stop).toHaveBeenCalledWith({ graceful: true, timeout: 25 });
    expect(database.close).toHaveBeenCalledOnce();
  });
});
