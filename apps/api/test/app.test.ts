import { describe, expect, it } from 'vitest';
import request from 'supertest';

import { createApiApp } from '../src/app.js';

describe('@journal/api operational shell', () => {
  it('reports its declared package dependency', async () => {
    const response = await request(createApiApp()).get('/').expect(200);

    expect(response.body).toEqual({
      dependencies: ['@journal/domain'],
      service: '@journal/api',
      status: 'ready',
    });
  });
});
