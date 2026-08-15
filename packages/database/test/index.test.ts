import { describe, expect, it } from 'vitest';

import { databasePackageName } from '../src/index.js';

describe('@journal/database operational shell', () => {
  it('exposes its package identity', () => {
    expect(databasePackageName).toBe('@journal/database');
  });
});
