import { describe, expect, it } from 'vitest';

import { processorsPackageName } from '../src/index.js';

describe('@journal/processors operational shell', () => {
  it('exposes its package identity', () => {
    expect(processorsPackageName).toBe('@journal/processors');
  });
});
