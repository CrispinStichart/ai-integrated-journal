import { describe, expect, it } from 'vitest';

import { storagePackageName } from '../src/index.js';

describe('@journal/storage operational shell', () => {
  it('exposes its package identity', () => {
    expect(storagePackageName).toBe('@journal/storage');
  });
});
