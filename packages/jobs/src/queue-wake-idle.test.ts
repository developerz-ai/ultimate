// What a PROVEN wake buys the idle loops: the ceiling they rest at, and what an idle minute costs
// a worker and a relay in claim statements. Split from `queue-wake.test.ts`, which owns how the
// wake is proven; here the proof is set directly (`setWakeLive`).

import { afterEach, describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock } from '@ultimat3/core';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive } from './enqueue-signal';
import {
  createIdleBackoff,
  IDLE_POLL_CEILING_MS,
  IDLE_REST_MAX_MS,
  WOKEN_IDLE_POLL_CEILING_MS,
} from './idle-backoff';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';
import { jobWorker } from './worker';

afterEach(() => {
  setWakeLive(false);
});

describe('the idle ceiling follows the wake', () => {
  test('2 s while nothing but the poll can find a job, 5 s once the wake is proven', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 250 });
    const idle = (): number[] => [1, 2, 3, 4, 5, 6, 7].map(() => backoff.next(false));
    expect(idle()).toEqual([250, 500, 1_000, 2_000, 2_000, 2_000, 2_000]);
    expect(IDLE_POLL_CEILING_MS).toBe(2_000);

    setWakeLive(true);
    backoff.reset();
    expect(idle()).toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
    expect(WOKEN_IDLE_POLL_CEILING_MS).toBe(5_000);

    // Lost again — a session that died, a proxy put in front: back under the guarantee at once.
    setWakeLive(false);
    expect(backoff.next(false)).toBe(2_000);
  });

  test('a declared idlePollMaxMs is the ceiling either way', () => {
    const backoff = createIdleBackoff({ subject: 'test', floorMs: 250, ceilingMs: 1_000 });
    setWakeLive(true);
    expect([1, 2, 3, 4].map(() => backoff.next(false))).toEqual([250, 500, 1_000, 1_000]);
  });
});

describe('an idle minute with a proven wake', () => {
  const MINUTE = 60_000;

  test('a worker on empty queues rests a minute: 3 statements, was 17 at the 5 s ceiling and 33 before', async () => {
    setWakeLive(true);
    const clock = frozenClock('2026-10-01T12:00:00.000Z');
    const driver = memoryJobDriver({ clock });
    let claims = 0;
    const worker = jobWorker({
      driver: {
        ...driver,
        claim: (options) => {
          claims += 1;
          return driver.claim(options);
        },
      },
      queues: ['default', 'mail'],
      clock,
      context: () => ctxOf({ role: 'worker', buildId: 'test' }),
      drainOnShutdown: false,
    });
    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await worker.tick();
      const { pollDelayMs } = await worker.stats();
      delays.push(pollDelayMs);
      elapsed += pollDelayMs;
    }
    // The first pass asks each queue once, the second — idle — one ask over both
    // (`worker-claim-sweep.ts`), and each says nothing is waiting or held (`onEmpty`). The first
    // empty pass keeps the floor — the throttled wake's promise (`IdleBackoff.settled`) — and the
    // second rests IDLE_REST_MAX_MS, no ramp (`worker-idle.test.ts` holds what it still catches).
    expect(delays).toEqual([250, IDLE_REST_MAX_MS]);
    expect(claims).toBe(3);
  });

  test('a relay converges to one claim every five seconds: 16 a minute, was 33', async () => {
    setWakeLive(true);
    let claims = 0;
    const store = memoryOutboxStore();
    const relay = outboxRelay({
      driver: memoryJobDriver(),
      store: {
        ...store,
        claim: (limit) => {
          claims += 1;
          return store.claim(limit);
        },
      },
      drainOnShutdown: false,
    });
    const delays: number[] = [];
    for (let elapsed = 0; elapsed < MINUTE; ) {
      await relay.tick();
      delays.push(relay.pollDelayMs());
      elapsed += relay.pollDelayMs();
    }
    expect(delays.slice(0, 7)).toEqual([200, 400, 800, 1_600, 3_200, 5_000, 5_000]);
    expect(claims).toBe(16);
  });
});
