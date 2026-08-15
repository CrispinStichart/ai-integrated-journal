import { domainPackageName } from '@journal/domain';
import express, { type Express } from 'express';

export function createApiApp(): Express {
  const app = express();
  app.get('/', (_request, response) => {
    response.json({
      dependencies: [domainPackageName],
      service: '@journal/api',
      status: 'ready',
    });
  });
  return app;
}
