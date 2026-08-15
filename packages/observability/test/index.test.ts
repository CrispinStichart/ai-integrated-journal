import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import {
  CONTENT_REDACTION,
  createContentSafeLogger,
  observabilityPackageName,
} from '../src/index.js';

describe('@journal/observability content-safe logging', () => {
  it('exposes its package identity', () => {
    expect(observabilityPackageName).toBe('@journal/observability');
  });

  it('denies journal content, credentials, and request data by default', () => {
    let output = '';
    const destination = new Writable({
      write(chunk, _encoding, callback) {
        output += String(chunk);
        callback();
      },
    });
    const logger = createContentSafeLogger({
      destination,
      service: 'redaction-test',
    });

    logger.info({
      body: 'private journal body',
      credentials: 'private credential',
      req: { headers: { authorization: 'private authorization' } },
      correlationId: 'safe-id',
    });

    expect(CONTENT_REDACTION).toBe('[Redacted]');
    expect(output).toContain('safe-id');
    expect(output).not.toContain('private journal body');
    expect(output).not.toContain('private credential');
    expect(output).not.toContain('private authorization');
  });
});
