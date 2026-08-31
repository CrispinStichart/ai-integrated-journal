import { describe, expect, it } from 'vitest';
import type { ConfigEnv, UserConfig, UserConfigFnObject } from 'vite';

import configuration from '../vite.config.js';

describe('local development network boundary', () => {
  it('[SEC-001][SEC-009] binds the browser/API proxy only to loopback', async () => {
    expect(typeof configuration).toBe('function');
    const factory = configuration as UserConfigFnObject;
    const environment: ConfigEnv = {
      command: 'serve',
      mode: 'development',
      isSsrBuild: false,
      isPreview: false,
    };
    const value = await factory(environment);
    const resolved = value as UserConfig;

    expect(resolved.server).toMatchObject({
      host: '127.0.0.1',
      strictPort: true,
      proxy: { '/api': 'http://127.0.0.1:3000' },
    });
  });
});
