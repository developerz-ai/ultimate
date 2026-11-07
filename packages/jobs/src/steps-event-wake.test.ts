// A waiting step's backstop follows the bus: 30 s when nothing wakes it, 15 min when a publish
// does (`EventLookup.wakes`), an explicit `eventPoll` either way. A waking bus is also asked once
// more after the park is written, so an event committed in between is not left to the backstop.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import { memoryEventBus } from './events';
import type { EventLookup } from './steps';
import { DEFAULT_EVENT_POLL_MS, isStepSuspension, stepRunner, WAKING_EVENT_POLL_MS } from './steps';
import { memoryStepStore } from './steps-memory';

const T0 = 1_760_000_000_000;
const PAID = t.object({ amount: t.number });

/** How long the run parks: the suspension's `resumeAt` less the clock it read. */
async function parkedFor(
  events: EventLookup,
  extra: { readonly eventPollMs?: number; readonly timeout?: number } = {},
): Promise<number> {
  const runner = stepRunner({
    runId: 'run-1',
    jobName: 'approve',
    store: memoryStepStore(),
    clock: frozenClock(T0),
    events,
    ...(extra.eventPollMs === undefined ? {} : { eventPollMs: extra.eventPollMs }),
  });
  try {
    await runner.step.waitForEvent('paid', 'invoice.paid', {
      schema: PAID,
      ...(extra.timeout === undefined ? {} : { timeout: extra.timeout }),
    });
  } catch (error) {
    if (isStepSuspension(error)) return error.resumeAt - T0;
    throw error;
  }
  return expect.unreachable('the wait answered with nothing published');
}

const quietBus = (wakes: boolean): EventLookup => ({
  wakes,
  now: () => Promise.resolve(T0),
  find: () => Promise.resolve(undefined),
});

describe('the backstop poll follows the bus', () => {
  test('a bus that wakes parks a wait for 15 min', async () => {
    expect(await parkedFor(quietBus(true))).toBe(WAKING_EVENT_POLL_MS);
    expect(WAKING_EVENT_POLL_MS).toBe(900_000);
  });

  test('a bus that does not wake parks it for 30 s, as before', async () => {
    expect(await parkedFor(quietBus(false))).toBe(DEFAULT_EVENT_POLL_MS);
    expect(await parkedFor(memoryEventBus({ clock: frozenClock(T0) }))).toBe(30_000);
  });

  test('an explicit eventPoll wins over either default', async () => {
    expect(await parkedFor(quietBus(true), { eventPollMs: 5_000 })).toBe(5_000);
    expect(await parkedFor(quietBus(false), { eventPollMs: 5_000 })).toBe(5_000);
  });

  test('a timeout sooner than the backstop parks until the timeout', async () => {
    expect(await parkedFor(quietBus(true), { timeout: 60_000 })).toBe(60_000);
  });

  test('a 24 h wait on a waking bus replays at most 96 times plus one', async () => {
    const store = memoryStepStore();
    let at = T0;
    const clock = { now: () => new Date(at), monotonic: () => at };
    let replays = 0;
    for (;;) {
      replays += 1;
      const runner = stepRunner({
        runId: 'run-1',
        jobName: 'approve',
        store,
        clock,
        events: { ...quietBus(true), now: () => Promise.resolve(at) },
      });
      try {
        const answer = await runner.step.waitForEvent('paid', 'invoice.paid', { schema: PAID });
        expect(answer).toBeUndefined();
        break;
      } catch (error) {
        if (!isStepSuspension(error)) throw error;
        at = error.resumeAt;
      }
    }
    expect(replays).toBeLessThanOrEqual(97);
  });
});

describe('a waking bus is asked once more after the park is written', () => {
  test('an event that lands between the first find and the park answers without a suspension', async () => {
    let asked = 0;
    const store = memoryStepStore();
    const events: EventLookup = {
      wakes: true,
      now: () => Promise.resolve(T0),
      // The first ask meets nothing; the publish commits while the `waiting` row is written.
      find: async () => {
        asked += 1;
        return asked === 1 ? undefined : { id: 'evt-1', payload: { amount: 12 }, publishedAt: T0 };
      },
    };
    const runner = stepRunner({ runId: 'run-1', jobName: 'approve', store, events });
    const answer = await runner.step.waitForEvent('paid', 'invoice.paid', { schema: PAID });
    expect(answer).toEqual({ amount: 12 });
    expect(asked).toBe(2);
    expect((await store.get('run-1', 'paid'))?.status).toBe('completed');
  });

  test('a bus that does not wake is asked once: its poll is the guarantee', async () => {
    let asked = 0;
    const events: EventLookup = {
      now: () => Promise.resolve(T0),
      find: async () => {
        asked += 1;
        return undefined;
      },
    };
    const runner = stepRunner({
      runId: 'run-1',
      jobName: 'approve',
      store: memoryStepStore(),
      events,
    });
    const thrown = await runner.step.waitForEvent('paid', 'invoice.paid', { schema: PAID }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isStepSuspension(thrown)).toBe(true);
    expect(asked).toBe(1);
  });
});
