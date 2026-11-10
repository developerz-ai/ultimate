// The event-bus suite over `memoryEventBus()` on a frozen clock — so a burst shares one millisecond
// and the id tie-break is what orders it — and the proof it can fail: a bus that floors a cursor at
// `publishedAt + 1` (steps over its own millisecond), and one that ignores the correlation key.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import type { EventBus } from '@ultimat3/jobs';
import { memoryEventBus } from '@ultimat3/jobs';
import type { EventBusSubject } from './event-bus-conformance';
import { EVENT_BUS_CHECKS, eventBusConformance } from './event-bus-conformance';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';

const onFrozenClock = (wrap: (inner: EventBus) => EventBus = (inner) => inner): EventBusSubject => {
  const clock = frozenClock('2026-11-09T00:00:00.000Z');
  return { bus: wrap(memoryEventBus({ clock })), elapse: clock.advance };
};

describe(testName('unit', 'the memory event bus'), () => {
  behavesLike(eventBusConformance, () => onFrozenClock());
});

/** The cursor as a floor one past its millisecond: every later event of that ms is skipped. */
const flooredCursor = (inner: EventBus): EventBus => ({
  ...inner,
  find: (name, key, afterMs, afterId, horizon, since) =>
    inner.find(name, key, afterId === undefined ? afterMs : afterMs + 1, undefined, horizon, since),
});

/** Every event of the name matches, whatever correlation key the wait asked for. */
const keyBlind = (inner: EventBus): EventBus => ({
  ...inner,
  find: (name, _key, afterMs, afterId, horizon, since) =>
    inner.find(name, undefined, afterMs, afterId, horizon, since),
});

const check = (prefix: string) =>
  EVENT_BUS_CHECKS.find((each) => each.name.startsWith(prefix)) ??
  expect.unreachable(`no event-bus check named ${prefix}`);

describe(testName('unit', 'a bus that breaks the event contract fails conformance'), () => {
  test('a cursor floored past its millisecond skips the rest of the burst', async () => {
    await check('find matches').run(onFrozenClock(flooredCursor));
    await expect(check('a cursor walks').run(onFrozenClock(flooredCursor))).rejects.toThrow();
  });

  test('a find that ignores the correlation key', async () => {
    await check('a cursor walks').run(onFrozenClock(keyBlind));
    await expect(check('find matches').run(onFrozenClock(keyBlind))).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = EVENT_BUS_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
