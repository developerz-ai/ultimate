// The memory bus is what `step.waitForEvent` reads when nobody installed a durable one, so its
// three rules ARE the semantics every bus has to match: an expired event is gone, the oldest event
// is what a full bus drops, and the earliest match wins so a resumed step consumes in order.

import { afterEach, describe, expect, test } from 'bun:test';
import { createMemoryEventBus, eventBus, publishEvent, setEventBus } from './events';

const clockAt = (start: number) => {
  let at = start;
  return {
    now: () => new Date(at),
    monotonic: () => at,
    advance: (ms: number) => {
      at += ms;
    },
  };
};

describe('the memory event bus', () => {
  test('an event past its ttl is purged, and purgeExpired says how many it removed', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock, defaultTtl: '1s' });
    await bus.publish('invoice.paid', { id: 'in_1' });
    await bus.publish('invoice.paid', { id: 'in_2' }, { ttl: '1h' });
    expect(bus.size()).toBe(2);

    clock.advance(1_000);
    // Exactly at the expiry, not past it: `expiresAt <= at` is the boundary a step's wait sits on.
    expect(bus.purgeExpired()).toBe(1);
    expect(bus.size()).toBe(1);
    expect((await bus.list()).map((event) => event.payload)).toEqual([{ id: 'in_2' }]);
  });

  test('an expired event is unmatchable even before anything purges it', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock, defaultTtl: '1s' });
    await bus.publish('invoice.paid', { id: 'in_1' });
    clock.advance(2_000);
    expect(await bus.find('invoice.paid', undefined, 0)).toBeUndefined();
    // Still in the map — the read applies the deadline, it does not depend on a sweep.
    expect(bus.size()).toBe(1);
  });

  test('a full bus drops the OLDEST event, never the newest one a step is waiting for', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock, maxEvents: 2 });
    await bus.publish('a', 1);
    clock.advance(10);
    await bus.publish('b', 2);
    clock.advance(10);
    await bus.publish('c', 3);

    expect(bus.size()).toBe(2);
    expect((await bus.list()).map((event) => event.name)).toEqual(['b', 'c']);
  });

  test('list is publication order and filters by name', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock });
    await bus.publish('a', 1);
    clock.advance(10);
    await bus.publish('b', 2);
    clock.advance(10);
    await bus.publish('a', 3);

    expect((await bus.list('a')).map((event) => event.payload)).toEqual([1, 3]);
    expect((await bus.list()).map((event) => event.name)).toEqual(['a', 'b', 'a']);
  });

  test('find takes the EARLIEST match at or after the wait, not the newest', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock });
    await bus.publish('invoice.paid', 'first', { correlationKey: 'org-1' });
    clock.advance(10);
    await bus.publish('invoice.paid', 'second', { correlationKey: 'org-1' });

    expect(await bus.find('invoice.paid', 'org-1', 0)).toEqual({
      payload: 'first',
      publishedAt: 1_000,
    });
    // A wait that began after the first one skips it: `afterMs` is the step's own cursor.
    expect(await bus.find('invoice.paid', 'org-1', 1_005)).toEqual({
      payload: 'second',
      publishedAt: 1_010,
    });
  });

  test('another run`s correlation key never matches — that is the whole point of the key', async () => {
    const clock = clockAt(1_000);
    const bus = createMemoryEventBus({ clock });
    await bus.publish('invoice.paid', 'theirs', { correlationKey: 'org-2' });
    expect(await bus.find('invoice.paid', 'org-1', 0)).toBeUndefined();
    // An uncorrelated wait matches anything of that name, which is the documented fallback.
    expect(await bus.find('invoice.paid', undefined, 0)).toEqual({
      payload: 'theirs',
      publishedAt: 1_000,
    });
  });
});

describe('the ambient bus', () => {
  const original = eventBus();
  afterEach(() => {
    // Restore exactly what was installed, never a fresh default: this is process-global state and
    // a test file that leaves its own bus behind strands every later file's waiting step.
    setEventBus(original);
  });

  test('publishEvent goes to whichever bus is installed', async () => {
    const installed = createMemoryEventBus({ clock: clockAt(1_000) });
    setEventBus(installed);
    expect(eventBus()).toBe(installed);

    const event = await publishEvent('invoice.paid', { id: 'in_1' }, { correlationKey: 'org-1' });

    expect(event.name).toBe('invoice.paid');
    expect(installed.size()).toBe(1);
    expect(await installed.find('invoice.paid', 'org-1', 0)).toEqual({
      payload: { id: 'in_1' },
      publishedAt: 1_000,
    });
  });
});
