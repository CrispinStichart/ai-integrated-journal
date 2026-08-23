import { createServer } from 'node:http';
import type { Server } from 'node:http';

import { silentLogger } from '@journal/observability';
import { describe, expect, it, vi } from 'vitest';

import { createGracefulShutdown } from '../src/shutdown.js';

describe('API-OPS graceful shutdown', () => {
  it('is idempotent and closes resources after stopping the server', async () => {
    const server = createServer((_request, response) => response.end('ok'));
    server.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const close = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({
      graceMilliseconds: 100,
      logger: silentLogger,
      resources: [{ close }],
      server,
    });

    const first = shutdown();
    const second = shutdown();
    await Promise.all([first, second]);

    expect(first).toBe(second);
    expect(close).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it('forces lingering connections closed only after the grace deadline', async () => {
    vi.useFakeTimers();
    const server = {
      close: vi.fn(),
      closeAllConnections: vi.fn(),
      closeIdleConnections: vi.fn(),
    } as unknown as Server;
    const close = vi.fn(async () => undefined);
    const shutdown = createGracefulShutdown({
      graceMilliseconds: 25,
      logger: silentLogger,
      resources: [{ close }],
      server,
    });

    const completion = shutdown();
    expect(server.closeAllConnections).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(25);
    await completion;

    expect(server.closeIdleConnections).toHaveBeenCalledOnce();
    expect(server.closeAllConnections).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });
});
