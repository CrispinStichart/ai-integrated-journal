import {
  problemDetailsSchema,
  type ErrorCode,
  type InvalidParameter,
} from '@journal/contracts';
import type { Request, Response } from 'express';
import type { z } from 'zod';

export function correlationId(response: Response): string {
  return String(response.locals.correlationId);
}

export function sendValidated<T extends z.ZodType>(
  response: Response,
  schema: T,
  value: z.input<T>,
  status = 200,
): void {
  response.status(status).json(schema.parse(value));
}

interface ProblemOptions {
  readonly status: number;
  readonly code: ErrorCode;
  readonly title: string;
  readonly detail?: string;
  readonly invalidParameters?: readonly InvalidParameter[];
}

export function sendProblem(
  request: Request,
  response: Response,
  options: ProblemOptions,
): void {
  const value = problemDetailsSchema.parse({
    type: `https://journal.local/problems/${options.code.replaceAll('_', '-')}`,
    title: options.title,
    status: options.status,
    code: options.code,
    correlationId: correlationId(response),
    instance: request.originalUrl,
    ...(options.detail === undefined ? {} : { detail: options.detail }),
    ...(options.invalidParameters === undefined
      ? {}
      : { invalidParameters: options.invalidParameters }),
  });
  response.status(options.status).type('application/problem+json').json(value);
}
