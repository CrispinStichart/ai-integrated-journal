import path from 'node:path';

import { z } from 'zod';

export const configPackageName = '@journal/config' as const;

const postgresUrl = z
  .url()
  .refine(
    (value) => ['postgres:', 'postgresql:'].includes(new URL(value).protocol),
    {
      error: 'must use the postgres or postgresql protocol',
    },
  );

const absolutePath = z
  .string()
  .min(1)
  .refine(path.isAbsolute, { error: 'must be an absolute path' });

const optionalAbsolutePath = z.preprocess(
  (value) => (value === '' ? undefined : value),
  absolutePath.optional(),
);

const environmentSchema = z
  .object({
    APP_ENV: z
      .enum(['development', 'test', 'production'])
      .default('development'),
    BLOB_DATA_DIR: absolutePath,
    DATABASE_URL: postgresUrl,
    HTTP_HOST: z.string().min(1).default('127.0.0.1'),
    HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
    LOG_LEVEL: z
      .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
      .default('info'),
    AUTH_ORIGIN: z.url().default('http://localhost:5173'),
    WEBAUTHN_RP_ID: z.string().min(1).default('localhost'),
    BACKUP_REPOSITORY_DIR: optionalAbsolutePath,
    BACKUP_PASSWORD_FILE: optionalAbsolutePath,
    BACKUP_STAGING_DIR: optionalAbsolutePath,
    AI_CREDENTIAL_ENCRYPTION_KEY: z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/, 'must be a base64url-encoded 256-bit key')
      .optional(),
  })
  .superRefine((value, context) => {
    const origin = new URL(value.AUTH_ORIGIN);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname);
    if (origin.protocol !== 'https:' && !local) {
      context.addIssue({
        code: 'custom',
        path: ['AUTH_ORIGIN'],
        message: 'must use HTTPS outside localhost',
      });
    }
    if (value.WEBAUTHN_RP_ID !== origin.hostname) {
      context.addIssue({
        code: 'custom',
        path: ['WEBAUTHN_RP_ID'],
        message: 'must match the authentication origin hostname',
      });
    }
  });

export type AppConfig = Readonly<{
  appEnv: z.infer<typeof environmentSchema>['APP_ENV'];
  auth: Readonly<{
    expectedOrigin: string;
    rpId: string;
    secureCookies: boolean;
  }>;
  blobDataDirectory: string;
  backup: Readonly<
    | { configured: false }
    | {
        configured: true;
        repositoryDirectory: string;
        passwordFile: string;
        stagingDirectory: string;
      }
  >;
  databaseUrl: string;
  http: Readonly<{ host: string; port: number }>;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
  credentialEncryptionKey?: string;
}>;

export class ConfigurationError extends Error {
  public readonly issues: readonly string[];

  public constructor(issues: readonly string[]) {
    super(`Invalid environment configuration:\n- ${issues.join('\n- ')}`);
    this.name = 'ConfigurationError';
    this.issues = issues;
  }
}

function issueMessage(issue: z.core.$ZodIssue): string {
  const key = issue.path.join('.') || 'environment';
  return `${key}: ${issue.message}`;
}

function pathsOverlap(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);
  return (
    normalizedLeft === normalizedRight ||
    normalizedLeft.startsWith(`${normalizedRight}${path.sep}`) ||
    normalizedRight.startsWith(`${normalizedLeft}${path.sep}`)
  );
}

/** Parses only supported keys and never includes environment values in errors. */
export function parseEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): AppConfig {
  const result = environmentSchema.safeParse({
    APP_ENV: environment.APP_ENV,
    BLOB_DATA_DIR: environment.BLOB_DATA_DIR,
    DATABASE_URL: environment.DATABASE_URL,
    HTTP_HOST: environment.HTTP_HOST,
    HTTP_PORT: environment.HTTP_PORT,
    LOG_LEVEL: environment.LOG_LEVEL,
    AUTH_ORIGIN: environment.AUTH_ORIGIN,
    WEBAUTHN_RP_ID: environment.WEBAUTHN_RP_ID,
    BACKUP_REPOSITORY_DIR: environment.BACKUP_REPOSITORY_DIR,
    BACKUP_PASSWORD_FILE: environment.BACKUP_PASSWORD_FILE,
    BACKUP_STAGING_DIR: environment.BACKUP_STAGING_DIR,
    AI_CREDENTIAL_ENCRYPTION_KEY: environment.AI_CREDENTIAL_ENCRYPTION_KEY,
  });

  if (!result.success) {
    throw new ConfigurationError(result.error.issues.map(issueMessage));
  }

  const backupValues = [
    result.data.BACKUP_REPOSITORY_DIR,
    result.data.BACKUP_PASSWORD_FILE,
    result.data.BACKUP_STAGING_DIR,
  ];
  const configuredBackupValues = backupValues.filter(
    (value): value is string => value !== undefined,
  );
  if (
    configuredBackupValues.length !== 0 &&
    configuredBackupValues.length !== backupValues.length
  ) {
    throw new ConfigurationError([
      'BACKUP_REPOSITORY_DIR, BACKUP_PASSWORD_FILE, and BACKUP_STAGING_DIR must be configured together',
    ]);
  }
  if (configuredBackupValues.length === backupValues.length) {
    const [repositoryDirectory, passwordFile, stagingDirectory] =
      configuredBackupValues;
    const blobDirectory = result.data.BLOB_DATA_DIR;
    if (
      repositoryDirectory === undefined ||
      passwordFile === undefined ||
      stagingDirectory === undefined
    ) {
      throw new ConfigurationError(['backup paths are incomplete']);
    }
    if (
      pathsOverlap(repositoryDirectory, blobDirectory) ||
      pathsOverlap(stagingDirectory, blobDirectory) ||
      pathsOverlap(repositoryDirectory, stagingDirectory) ||
      pathsOverlap(passwordFile, repositoryDirectory) ||
      pathsOverlap(passwordFile, blobDirectory)
    ) {
      throw new ConfigurationError([
        'backup repository, password, staging, and live blob paths must not overlap',
      ]);
    }
  }

  return Object.freeze({
    appEnv: result.data.APP_ENV,
    auth: Object.freeze({
      expectedOrigin: result.data.AUTH_ORIGIN,
      rpId: result.data.WEBAUTHN_RP_ID,
      secureCookies: new URL(result.data.AUTH_ORIGIN).protocol === 'https:',
    }),
    blobDataDirectory: result.data.BLOB_DATA_DIR,
    backup: Object.freeze(
      configuredBackupValues.length === 0
        ? { configured: false }
        : {
            configured: true,
            repositoryDirectory: configuredBackupValues[0] as string,
            passwordFile: configuredBackupValues[1] as string,
            stagingDirectory: configuredBackupValues[2] as string,
          },
    ),
    databaseUrl: result.data.DATABASE_URL,
    http: Object.freeze({
      host: result.data.HTTP_HOST,
      port: result.data.HTTP_PORT,
    }),
    logLevel: result.data.LOG_LEVEL,
    ...(result.data.AI_CREDENTIAL_ENCRYPTION_KEY === undefined
      ? {}
      : { credentialEncryptionKey: result.data.AI_CREDENTIAL_ENCRYPTION_KEY }),
  });
}

let processConfig: AppConfig | undefined;

/** Loads and caches process configuration so startup parsing occurs exactly once. */
export function loadConfig(): AppConfig {
  processConfig ??= parseEnvironment(process.env);
  return processConfig;
}
