import { describe, expect, it } from 'vitest';

import { configPackageName } from '../src/index.js';

describe('@journal/config operational shell', () => {
  it('exposes its package identity', () => {
    expect(configPackageName).toBe('@journal/config');
  });
});
