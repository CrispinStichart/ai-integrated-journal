import pino, { type DestinationStream, type Level, type Logger } from 'pino';

export const observabilityPackageName = '@journal/observability' as const;

export const CONTENT_REDACTION = '[Redacted]';

const PRIVATE_PATHS = [
  'audio',
  'body',
  'content',
  'cookie',
  'credentials',
  'journal',
  'password',
  'prompt',
  'providerResponse',
  'req.body',
  'req.headers',
  'res.body',
  'response',
  'text',
  'token',
] as const;

const OPERATIONAL_FIELDS = new Set([
  'code',
  'correlationId',
  'dependency',
  'errorType',
  'forced',
  'host',
  'jobId',
  'latencyMs',
  'method',
  'port',
  'route',
  'runId',
  'status',
]);

export interface ContentSafeLogMethod {
  (message: string): void;
  (fields: Readonly<Record<string, unknown>>, message?: string): void;
}

export interface ContentSafeLogger {
  readonly debug: ContentSafeLogMethod;
  readonly error: ContentSafeLogMethod;
  readonly fatal: ContentSafeLogMethod;
  readonly info: ContentSafeLogMethod;
  readonly trace: ContentSafeLogMethod;
  readonly warn: ContentSafeLogMethod;
}

export interface CreateContentSafeLoggerOptions {
  readonly service: string;
  readonly level?: string;
  readonly destination?: DestinationStream;
}

function allowOperationalFields(
  fields: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(fields).filter(([key]) => OPERATIONAL_FIELDS.has(key)),
  );
}

function logMethod(logger: Logger, level: Level): ContentSafeLogMethod {
  return (
    fieldsOrMessage: string | Readonly<Record<string, unknown>>,
    message?: string,
  ) => {
    if (typeof fieldsOrMessage === 'string') {
      logger[level](fieldsOrMessage);
      return;
    }
    logger[level](allowOperationalFields(fieldsOrMessage), message);
  };
}

function contentSafeFacade(logger: Logger): ContentSafeLogger {
  return Object.freeze({
    debug: logMethod(logger, 'debug'),
    error: logMethod(logger, 'error'),
    fatal: logMethod(logger, 'fatal'),
    info: logMethod(logger, 'info'),
    trace: logMethod(logger, 'trace'),
    warn: logMethod(logger, 'warn'),
  });
}

/** Creates a logger that admits only explicitly safe operational metadata. */
export function createContentSafeLogger(
  options: CreateContentSafeLoggerOptions,
): ContentSafeLogger {
  return contentSafeFacade(
    pino(
      {
        base: { service: options.service },
        level: options.level ?? 'info',
        redact: {
          paths: PRIVATE_PATHS.flatMap((path) => [path, `*.${path}`]),
          censor: CONTENT_REDACTION,
        },
      },
      options.destination,
    ),
  );
}

export const silentLogger: ContentSafeLogger = contentSafeFacade(
  pino({ level: 'silent' }),
);
