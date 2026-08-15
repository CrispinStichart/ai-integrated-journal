import type { Server } from 'node:http';

import type { ContentSafeLogger } from '@journal/observability';

export interface CloseableResource {
  close(): Promise<void>;
}

export interface GracefulShutdownOptions {
  readonly server: Server;
  readonly resources: readonly CloseableResource[];
  readonly logger: ContentSafeLogger;
  readonly graceMilliseconds?: number;
}

/** Stops admission, drains requests for a bounded period, then closes resources. */
export function createGracefulShutdown(
  options: GracefulShutdownOptions,
): () => Promise<void> {
  let shutdown: Promise<void> | undefined;

  return () => {
    shutdown ??= (async () => {
      options.logger.info('API shutdown started');
      const graceMilliseconds = options.graceMilliseconds ?? 10_000;
      let forced = false;
      const drained = new Promise<void>((resolve, reject) => {
        options.server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
        options.server.closeIdleConnections();
      });
      const timeout = new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          forced = true;
          options.server.closeAllConnections();
          resolve();
        }, graceMilliseconds);
        timer.unref();
      });
      await Promise.race([drained, timeout]);
      for (const resource of [...options.resources].reverse()) {
        await resource.close();
      }
      options.logger.info({ forced }, 'API shutdown completed');
    })();
    return shutdown;
  };
}
