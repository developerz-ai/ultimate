// The outbox relay stamps its heartbeat (`loop-heartbeat.ts`): a claim that never returns is
// stale within the bound, an idle relay resting on a live wake stays fresh, a stopped one is not
// judged.

import { afterEach, describe, expect, test } from 'bun:test';
import { memoryJobDriver } from './driver-memory';
import { setWakeLive } from './enqueue-signal';
import { useFakeTime } from './fake-time-fixture';
import { LIVENESS_FLOOR_MS, staleLoops } from './loop-heartbeat';
import type { OutboxStore } from './outbox';
import { memoryOutboxStore } from './outbox';
import { outboxRelay } from './outbox-relay';

afterEach(() => {
  setWakeLive(false);
});

const time = useFakeTime();

describe('unit · outbox relay heartbeat', () => {
  test('a claim that never returns turns the relay stale within its bound', async () => {
    const inner = memoryOutboxStore();
    let claims = 0;
    let release = (): void => undefined;
    const store: OutboxStore = {
      ...inner,
      async claim(limit, options) {
        claims += 1;
        if (claims === 2) await new Promise<void>((done) => (release = done));
        return inner.claim(limit, options);
      },
    };
    const relay = outboxRelay({
      driver: memoryJobDriver(),
      store,
      intervalMs: 25,
      drainOnShutdown: false,
    });
    relay.start();
    try {
      await time.until(() => claims === 2);
      await time.advance(LIVENESS_FLOOR_MS - 1_000, 1_000);
      expect(staleLoops()).toEqual([]);
      await time.advance(2_000, 1_000);
      expect(staleLoops().map((loop) => [loop.name, loop.reason])).toEqual([
        ['outboxRelay', 'held'],
      ]);
    } finally {
      release();
      await relay.stop();
    }
    expect(staleLoops()).toEqual([]);
  });

  test('an idle relay resting on a live wake stays fresh for minutes', async () => {
    setWakeLive(true);
    const relay = outboxRelay({
      driver: memoryJobDriver(),
      store: memoryOutboxStore(),
      intervalMs: 25,
      drainOnShutdown: false,
    });
    relay.start();
    try {
      await time.advance(5 * 60_000, 500);
      expect(staleLoops()).toEqual([]);
    } finally {
      await relay.stop();
    }
  });
});
