import { describe, expect, it, vi } from 'vitest';

import { createInMemoryEventFeed } from '../src/events.js';

const event = (eventId: string) => ({
  eventId,
  eventType: 'run.updated',
  schemaVersion: 1 as const,
  occurredAt: '2026-08-15T12:00:00.000Z',
  payload: {},
});

describe('API-OPS in-memory event feed', () => {
  it('bounds replay history and supports unsubscribe', async () => {
    const feed = createInMemoryEventFeed(1);
    const first = event('019c5b90-0000-7000-8000-000000000010');
    const second = event('019c5b90-0000-7000-8000-000000000011');
    feed.publish('owner', first);
    feed.publish('owner', second);

    expect(await feed.poll('owner', undefined)).toEqual([second]);
    const listener = vi.fn();
    const unsubscribe = await feed.watch('owner', second.eventId, listener);
    const third = event('019c5b90-0000-7000-8000-000000000012');
    feed.publish('owner', third);
    unsubscribe();
    feed.publish('owner', event('019c5b90-0000-7000-8000-000000000013'));

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(third);
  });

  it('rejects invalid capacities and envelopes', () => {
    expect(() => createInMemoryEventFeed(0)).toThrow(RangeError);
    const feed = createInMemoryEventFeed();
    expect(() =>
      feed.publish('owner', {
        ...event('not-a-uuid'),
        eventId: 'not-a-uuid',
      }),
    ).toThrow();
  });

  it('[API-OPS] replays only later events for the requested owner', async () => {
    const feed = createInMemoryEventFeed();
    const first = event('019c5b90-0000-7000-8000-000000000020');
    const otherOwner = event('019c5b90-0000-7000-8000-000000000021');
    const second = event('019c5b90-0000-7000-8000-000000000022');
    feed.publish('owner', first);
    feed.publish('other-owner', otherOwner);
    feed.publish('owner', second);

    await expect(feed.poll('owner', first.eventId)).resolves.toEqual([second]);
    await expect(
      feed.poll('owner', '019c5b90-0000-7000-8000-000000000099'),
    ).resolves.toEqual([first, second]);
  });
});
