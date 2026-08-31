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
      backup: { configured: false },
      blobDataDirectory: '/var/lib/ai-integrated-journal/blobs',
      databaseUrl: 'postgresql://journal@localhost:5432/journal',
      http: { host: '127.0.0.1', port: 4321 },
      logLevel: 'info',
    });
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.http)).toBe(true);
    expect(Object.isFrozen(config.auth)).toBe(true);
    expect(Object.isFrozen(config.backup)).toBe(true);
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
    [
      {
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
        HTTP_HOST: '0.0.0.0',
      },
      'HTTP_HOST',
    ],
  ])('fails fast when configuration is invalid', (environment, expectedKey) => {
    expect(() => parseEnvironment(environment)).toThrow(ConfigurationError);
    expect(() => parseEnvironment(environment)).toThrow(expectedKey);
  });

  it('[SEC-001][SEC-009] permits only explicit loopback API bindings', () => {
    for (const host of ['localhost', '127.0.0.1', '::1']) {
      expect(
        parseEnvironment({
          BLOB_DATA_DIR: '/tmp/blobs',
          DATABASE_URL: 'postgresql://journal@localhost/journal',
          HTTP_HOST: host,
        }).http.host,
      ).toBe(host);
    }

    for (const host of [
      '192.168.1.10',
      '10.0.0.5',
      'journal.local',
      '::',
      '[::1]',
    ]) {
      expect(() =>
        parseEnvironment({
          BLOB_DATA_DIR: '/tmp/blobs',
          DATABASE_URL: 'postgresql://journal@localhost/journal',
          HTTP_HOST: host,
        }),
      ).toThrowError(/HTTP_HOST: must bind to a loopback address/u);
    }
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

  it('[PORT-001][SEC-005] requires a complete non-secret backup path set', () => {
    expect(() =>
      parseEnvironment({
        BACKUP_REPOSITORY_DIR: '/var/backups/journal',
        BLOB_DATA_DIR: '/var/lib/journal/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      }),
    ).toThrowError(/must be configured together/u);

    const config = parseEnvironment({
      BACKUP_PASSWORD_FILE: '/var/lib/journal-secrets/restic.password',
      BACKUP_REPOSITORY_DIR: '/var/backups/journal',
      BACKUP_STAGING_DIR: '/var/cache/journal-backup',
      BLOB_DATA_DIR: '/var/lib/journal/blobs',
      DATABASE_URL: 'postgresql://journal@localhost/journal',
    });
    expect(config.backup).toEqual({
      configured: true,
      passwordFile: '/var/lib/journal-secrets/restic.password',
      repositoryDirectory: '/var/backups/journal',
      stagingDirectory: '/var/cache/journal-backup',
    });

    expect(() =>
      parseEnvironment({
        BACKUP_PASSWORD_FILE: '/var/lib/journal-secrets/restic.password',
        BACKUP_REPOSITORY_DIR: '/var/lib/journal/blobs/repository',
        BACKUP_STAGING_DIR: '/var/cache/journal-backup',
        BLOB_DATA_DIR: '/var/lib/journal/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      }),
    ).toThrowError(/must not overlap/u);
  });

  it('[SEC-003] validates and exposes only a correctly encoded provider credential encryption key', () => {
    const key = Buffer.alloc(32, 9).toString('base64url');
    const config = parseEnvironment({
      AI_CREDENTIAL_ENCRYPTION_KEY: key,
      BLOB_DATA_DIR: '/tmp/blobs',
      DATABASE_URL: 'postgresql://journal@localhost/journal',
    });
    expect(config.credentialEncryptionKey).toBe(key);

    expect(() =>
      parseEnvironment({
        AI_CREDENTIAL_ENCRYPTION_KEY: 'not-a-256-bit-key',
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
      }),
    ).toThrowError(/AI_CREDENTIAL_ENCRYPTION_KEY/u);
  });

  it('enables secure cookies for a matching public HTTPS authentication origin', () => {
    const config = parseEnvironment({
      AUTH_ORIGIN: 'https://journal.example',
      BLOB_DATA_DIR: '/tmp/blobs',
      DATABASE_URL: 'postgresql://journal@localhost/journal',
      WEBAUTHN_RP_ID: 'journal.example',
    });

    expect(config.auth).toEqual({
      expectedOrigin: 'https://journal.example',
      rpId: 'journal.example',
      secureCookies: true,
    });
  });

  it('rejects a WebAuthn relying-party ID that does not match the origin', () => {
    expect(() =>
      parseEnvironment({
        AUTH_ORIGIN: 'https://journal.example',
        BLOB_DATA_DIR: '/tmp/blobs',
        DATABASE_URL: 'postgresql://journal@localhost/journal',
        WEBAUTHN_RP_ID: 'attacker.example',
      }),
    ).toThrowError(/WEBAUTHN_RP_ID: must match/);
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
