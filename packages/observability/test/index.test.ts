import { describe, expect, it } from 'vitest';

import { observabilityPackageName } from '../src/index.js';

describe('@journal/observability operational shell', () => {
  it('exposes its package identity', () => {
    expect(observabilityPackageName).toBe('@journal/observability');
  });
});
