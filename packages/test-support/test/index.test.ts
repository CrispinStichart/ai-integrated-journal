import { describe, expect, it } from 'vitest';

import { testSupportPackageName } from '../src/index.js';

describe('@journal/test-support operational shell', () => {
  it('exposes its package identity', () => {
    expect(testSupportPackageName).toBe('@journal/test-support');
  });
});
