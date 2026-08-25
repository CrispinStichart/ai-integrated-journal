import type { DatabaseClient, QueueJobPayload } from '@journal/database';
import { createJobFingerprint } from '@journal/database';
import { describe, expect, it } from 'vitest';

import {
  NUDGE_DIGEST_OPERATION,
  NudgeDigestJobHandler,
} from '../src/nudge-engine.js';

const payload: QueueJobPayload = {
  schemaVersion: 1,
  operation: NUDGE_DIGEST_OPERATION,
  identifiers: { scheduleKey: 'nudges.digest' },
  fingerprint: createJobFingerprint({
    queueName: 'journal.notifications',
    operation: NUDGE_DIGEST_OPERATION,
    identifiers: { scheduleKey: 'nudges.digest' },
  }),
};

describe('scheduled nudge digest worker', () => {
  it('[NUDGE-005][STATE-003] accepts only the content-free scheduled identifier contract', async () => {
    const handler = new NudgeDigestJobHandler({} as DatabaseClient);
    await expect(handler.load(payload)).resolves.toEqual({
      input: true,
      state: 'runnable',
    });
    expect(() => handler.load({ ...payload, operation: 'unexpected' })).toThrow(
      expect.objectContaining({ disposition: 'permanent' }),
    );
    expect(JSON.stringify(payload)).not.toMatch(/journalText|prompt|response/u);
  });
});
