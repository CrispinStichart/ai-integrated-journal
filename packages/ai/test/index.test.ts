import { describe, expect, it } from 'vitest';

import { aiPackageName } from '../src/index.js';

describe('@journal/ai operational shell', () => {
  it('exposes its package identity', () => {
    expect(aiPackageName).toBe('@journal/ai');
  });
});
