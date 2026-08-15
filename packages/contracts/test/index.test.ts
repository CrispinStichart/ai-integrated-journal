import { describe, expect, it } from 'vitest';

import { contractsPackageName } from '../src/index.js';

describe('@journal/contracts operational shell', () => {
  it('exposes its package identity', () => {
    expect(contractsPackageName).toBe('@journal/contracts');
  });
});
