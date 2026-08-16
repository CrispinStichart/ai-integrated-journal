import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ConfigurationError,
  configPackageName,
  parseEnvironment,
} from '../src/index.js';

describe('@journal/config operational shell', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('exposes its package identity', () => {
    expect(configPackageName).toBe('@journal/config');
  });

  it('parses required settings, defaults, and primitive types', () => {
    const config = parseEnvironment({
      BLOB_DATA_DIR: '/var/lib/ai-integrated-journal/blobs',
      DATABASE_URL: 'postgresql://journal@localhost:5432/journal',
      HTTP_PORT: '4321',
    });

    expect(config).toEqual({
      appEnv: 'development',
      auth: {
        expectedOrigin: 'http://localhost:5173',
        rpId: 'localhost',
        secureCookies: false,
      },
      blobDataDirectory: '/var/lib/ai-integrated-journal/blobs',
      databaseUrl: 'postgresql://journal@localhost:5432/journal',
      http: { host: '127.0.0.1', port: 4321 },
      logLevel: 'info',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
  });

  it.each([
    [{ BLOB_DATA_DIR: '/tmp/blobs' }, 'DATABASE_URL'],
    [
      {
        BLOB_DATA_DIR: 'relative/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      },
      'BLOB_DATA_DIR',
    ],
    [
      {
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'https://localhost/journal',
      },
      'DATABASE_URL',
    ],
    [
      {
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
        HTTP_PORT: '0',
      },
      'HTTP_PORT',
    ],
    [
      {
        AUTH_ORIGIN: 'http://journal.example',
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
        WEBAUTHN_RP_ID: 'journal.example',
      },
      'AUTH_ORIGIN',
    ],
  ])('fails fast when configuration is invalid', (environment, expectedKey) => {
    expect(() => parseEnvironment(environment)).toThrow(ConfigurationError);
    expect(() => parseEnvironment(environment)).toThrow(expectedKey);
  });

  it('does not expose a rejected secret value in its error', () => {
    const secret = 'do-not-print-this-secret';

    expect(() =>
      parseEnvironment({
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: secret,
      }),
    ).toThrowError(expect.not.stringContaining(secret));
  });

  it('loads process configuration only once', async () => {
    vi.stubEnv('BLOB_DATA_DIR', '/tmp/first');
    vi.stubEnv('DATABASE_URL', 'postgresql://journal@localhost/first');
    vi.resetModules();
    const { loadConfig } = await import('../src/index.js');
    const first = loadConfig();

    vi.stubEnv('BLOB_DATA_DIR', '/tmp/second');

    expect(loadConfig()).toBe(first);
    expect(loadConfig().blobDataDirectory).toBe('/tmp/first');
  });
});
