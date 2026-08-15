import {
  sseEventEnvelopeSchema,
  type SseEventEnvelope,
} from '@journal/contracts';

import type { EventFeed } from './types.js';

interface StoredEvent {
  readonly ownerId: string;
  readonly event: SseEventEnvelope;
}

interface Subscriber {
  readonly ownerId: string;
  readonly listener: (event: SseEventEnvelope) => void;
}

export interface InMemoryEventFeed extends EventFeed {
  publish(ownerId: string, event: SseEventEnvelope): void;
}

/** Bounded local feed used until the durable queue-backed event adapter lands. */
export function createInMemoryEventFeed(maxEvents = 1_000): InMemoryEventFeed {
  if (!Number.isSafeInteger(maxEvents) || maxEvents < 1) {
    throw new RangeError('maxEvents must be a positive safe integer.');
  }

  const events: StoredEvent[] = [];
  const subscribers = new Set<Subscriber>();

  function eventsAfter(
    ownerId: string,
    afterEventId: string | undefined,
  ): SseEventEnvelope[] {
    const owned = events.filter((item) => item.ownerId === ownerId);
    if (afterEventId === undefined) return owned.map((item) => item.event);
    const position = owned.findIndex(
      (item) => item.event.eventId === afterEventId,
    );
    return position < 0
      ? owned.map((item) => item.event)
      : owned.slice(position + 1).map((item) => item.event);
  }

  return {
    poll: async (ownerId, afterEventId) => eventsAfter(ownerId, afterEventId),
    publish(ownerId, input) {
      const event = sseEventEnvelopeSchema.parse(input);
      events.push({ event, ownerId });
      if (events.length > maxEvents)
        events.splice(0, events.length - maxEvents);
      for (const subscriber of subscribers) {
        if (subscriber.ownerId === ownerId) subscriber.listener(event);
      }
    },
    async watch(ownerId, afterEventId, listener) {
      for (const event of eventsAfter(ownerId, afterEventId)) listener(event);
      const subscriber = { listener, ownerId };
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
  };
}
