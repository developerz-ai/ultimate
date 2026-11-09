// One clock: a store built with no `clock` reads "now" from `installClock`'s frame at each call —
// `runtime.ts`'s clock and a test's frozen one reach it, even when installed after the build.

import { expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { installClock } from '@ultimat3/core/adapter';
import { memoryEventBus } from './events';

test('a default-clock event bus stamps the installed clock, read at the call', async () => {
  const bus = memoryEventBus();
  const release = installClock(frozenClock('2001-02-03T04:05:06Z'));
  try {
    const event = await bus.publish('clock.probe', {});
    expect(event.publishedAt).toBe(Date.parse('2001-02-03T04:05:06Z'));
  } finally {
    release();
  }
});
