// `step.waitForEvent` and the two clocks it could read. `publishedAt` is the BUS's — the
// database's, in production — so a wait stamped by the worker's own clock compares two machines:
// a worker 5 s ahead never matched an event published in the 5 s after it began waiting, and the
// run sat out its timeout (24 h by default).

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { memoryEventBus } from './events';
import type { EventLookup, StepStore } from './steps';
import { createStepRunner, isStepSuspension } from './steps';
import { memoryStepStore } from './steps-memory';

const T0 = 1_790_000_000_000;
const SKEW_MS = 5_000;

function fakeClock(startMs: number): Clock & { advance(ms: number): void } {
  let current = startMs;
  return {
    now: () => new Date(current),
    monotonic: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

let store: StepStore;

beforeEach(() => {
  store = memoryStepStore();
});

describe('a wait is stamped by the bus that stamps the answer', () => {
  test('a runner 5 s AHEAD of the bus still matches an event published 6 ms after it asked', async () => {
    const database = fakeClock(T0);
    const worker = fakeClock(T0 + SKEW_MS);
    const events = memoryEventBus({ clock: database });
    const attempt = (): Promise<unknown> =>
      createStepRunner({
        runId: 'run-skew',
        jobName: 'awaitOtp',
        store,
        clock: worker,
        events,
      }).step.waitForEvent('otp', 'otp.entered', { timeout: '1h' });

    expect(isStepSuspension(await attempt().catch((error: unknown) => error))).toBe(true);
    expect((await store.get('run-skew', 'otp'))?.startedAt).toBe(T0);

    database.advance(6);
    await events.publish('otp.entered', { code: 42 });
    database.advance(30_000);
    worker.advance(30_006);
    expect(await attempt()).toEqual({ code: 42 });
  });

  test('a runner 5 s BEHIND does not take an answer published before it asked', async () => {
    const database = fakeClock(T0);
    const worker = fakeClock(T0 - SKEW_MS);
    const events = memoryEventBus({ clock: database });
    database.advance(-1_000);
    await events.publish('otp.entered', { code: 'stale' });
    database.advance(1_000);

    const outcome = await createStepRunner({
      runId: 'run-behind',
      jobName: 'awaitOtp',
      store,
      clock: worker,
      events,
    })
      .step.waitForEvent('otp', 'otp.entered', { timeout: '1h' })
      .catch((error: unknown) => error);
    expect(isStepSuspension(outcome)).toBe(true);
  });

  test('the bus is asked ONCE per wait: a re-poll keeps the stamp it persisted', async () => {
    const database = fakeClock(T0);
    const worker = fakeClock(T0 + SKEW_MS);
    const bus = memoryEventBus({ clock: database });
    let asked = 0;
    const events: EventLookup = {
      find: bus.find,
      now() {
        asked += 1;
        return bus.now();
      },
    };
    for (let poll = 0; poll < 3; poll += 1) {
      await createStepRunner({ runId: 'run-poll', jobName: 'j', store, clock: worker, events })
        .step.waitForEvent('otp', 'otp.entered', { timeout: '1h' })
        .catch((error: unknown) => error);
      database.advance(30_000);
      worker.advance(30_000);
    }
    expect(asked).toBe(1);
    expect((await store.get('run-poll', 'otp'))?.startedAt).toBe(T0);
  });

  test('with no bus at all the runner clock is the only one there is', async () => {
    const worker = fakeClock(T0 + SKEW_MS);
    await createStepRunner({ runId: 'run-none', jobName: 'j', store, clock: worker })
      .step.waitForEvent('otp', 'otp.entered', { timeout: '1h' })
      .catch((error: unknown) => error);
    expect((await store.get('run-none', 'otp'))?.startedAt).toBe(T0 + SKEW_MS);
  });

  test("a runner 5 s AHEAD does not give up early: the timeout is the bus's to call", async () => {
    const database = fakeClock(T0);
    const worker = fakeClock(T0 + SKEW_MS);
    const bus = memoryEventBus({ clock: database });
    let asked = 0;
    const events: EventLookup = {
      find: bus.find,
      now() {
        asked += 1;
        return bus.now();
      },
    };
    const attempt = (required = false): Promise<unknown> =>
      createStepRunner({ runId: 'run-early', jobName: 'awaitOtp', store, clock: worker, events })
        .step.waitForEvent('otp', 'otp.entered', { timeout: '10s', required })
        .catch((error: unknown) => error);

    expect(isStepSuspension(await attempt())).toBe(true);
    // 6 s in on the bus; 11 s past the wait's stamp by the worker's reckoning.
    database.advance(6_000);
    worker.advance(6_000);
    const early = await attempt(true);
    if (!isStepSuspension(early)) return expect.unreachable('the wait gave up 4 s early');
    // Parked for exactly what the BUS says is left, on the worker's own clock.
    expect(early.resumeAt).toBe(worker.now().getTime() + 4_000);
    expect(asked).toBe(2);

    database.advance(1_000);
    await bus.publish('otp.entered', { code: 42 });
    database.advance(3_000);
    worker.advance(4_000);
    expect(await attempt()).toEqual({ code: 42 });
  });

  test('once the BUS is past the deadline the wait times out', async () => {
    const database = fakeClock(T0);
    const worker = fakeClock(T0 + SKEW_MS);
    const events = memoryEventBus({ clock: database });
    const attempt = (): Promise<unknown> =>
      createStepRunner({ runId: 'run-late', jobName: 'awaitOtp', store, clock: worker, events })
        .step.waitForEvent('otp', 'otp.entered', { timeout: '10s' })
        .catch((error: unknown) => error);

    expect(isStepSuspension(await attempt())).toBe(true);
    database.advance(10_000);
    worker.advance(10_000);
    expect(await attempt()).toBeUndefined();
  });
});
