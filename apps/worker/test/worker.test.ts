import { describe, expect, it } from 'vitest';

import { getWorkerStatus } from '../src/worker.js';

describe('@journal/worker operational shell', () => {
  it('reports its declared package dependency', () => {
    expect(getWorkerStatus()).toEqual({
      dependencies: ['@journal/processors'],
      service: '@journal/worker',
      status: 'ready',
    });
  });
});
