import { describe, expect, it } from 'vitest';

import { domainPackageName } from '../src/index.js';

describe('@journal/domain operational shell', () => {
  it('exposes its package identity', () => {
    expect(domainPackageName).toBe('@journal/domain');
  });
});
