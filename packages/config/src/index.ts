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

const environmentSchema = z.object({
  APP_ENV: z.enum(['development', 'test', 'production']).default('development'),
  BLOB_DATA_DIR: absolutePath,
  DATABASE_URL: postgresUrl,
  HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  HTTP_PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
});

export type AppConfig = Readonly<{
  appEnv: z.infer<typeof environmentSchema>['APP_ENV'];
  blobDataDirectory: string;
  databaseUrl: string;
  http: Readonly<{ host: string; port: number }>;
  logLevel: z.infer<typeof environmentSchema>['LOG_LEVEL'];
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
  });

  if (!result.success) {
    throw new ConfigurationError(result.error.issues.map(issueMessage));
  }

  return Object.freeze({
    appEnv: result.data.APP_ENV,
    blobDataDirectory: result.data.BLOB_DATA_DIR,
    databaseUrl: result.data.DATABASE_URL,
    http: Object.freeze({
      host: result.data.HTTP_HOST,
      port: result.data.HTTP_PORT,
    }),
    logLevel: result.data.LOG_LEVEL,
  });
}

let processConfig: AppConfig | undefined;

/** Loads and caches process configuration so startup parsing occurs exactly once. */
export function loadConfig(): AppConfig {
  processConfig ??= parseEnvironment(process.env);
  return processConfig;
}
