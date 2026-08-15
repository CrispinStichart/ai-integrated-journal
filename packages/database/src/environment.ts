export type ApplicationEnvironment = 'development' | 'test' | 'production';

export interface DatabaseCommandEnvironment {
  readonly appEnvironment: ApplicationEnvironment;
  readonly databaseUrl: string;
}

export function parseDatabaseCommandEnvironment(
  environment: NodeJS.ProcessEnv,
): DatabaseCommandEnvironment {
  const databaseUrl = environment.DATABASE_URL;
  if (databaseUrl === undefined) {
    throw new Error('DATABASE_URL is required');
  }

  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a valid PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol)) {
    throw new Error(
      'DATABASE_URL must use the postgres or postgresql protocol',
    );
  }

  const appEnvironment = environment.APP_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(appEnvironment)) {
    throw new Error('APP_ENV must be development, test, or production');
  }

  return Object.freeze({
    appEnvironment: appEnvironment as ApplicationEnvironment,
    databaseUrl,
  });
}
