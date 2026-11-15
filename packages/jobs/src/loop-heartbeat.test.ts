// A loop's heartbeat, judged on fake time: a silent periodic loop and a pass held open both turn
// stale past the bound, an event-driven loop at rest never does, and a stopped loop is not judged.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  LIVENESS_FLOOR_MS,
  LIVENESS_TICK_MULTIPLE,
  livenessBoundMs,
  loopHeartbeat,
  staleLoops,
} from './loop-heartbeat';

let at = 0;
const now = (): number => at;
const started: { stop(): void }[] = [];

afterEach(() => {
  for (const beat of started.splice(0)) beat.stop();
  at = 0;
});

const begin = (name: string, tickMs: number, periodic = true) => {
  const beat = loopHeartbeat(name, { tickMs, periodic, now });
  beat.start();
  started.push(beat);
  return beat;
};

describe('unit · loop heartbeat', () => {
  test('the bound is the declared multiple of the tick, never under the floor', () => {
    expect(livenessBoundMs(250)).toBe(LIVENESS_FLOOR_MS);
    expect(livenessBoundMs(60_000)).toBe(LIVENESS_TICK_MULTIPLE * 60_000);
    // The floor outlasts the longest rest an idle loop takes (`IDLE_REST_MAX_MS`).
    expect(LIVENESS_FLOOR_MS).toBeGreaterThan(60_000);
  });

  test('a periodic loop that stops stamping is stale past its bound, and fresh again on a stamp', () => {
    const beat = begin('worker', 250);
    at = LIVENESS_FLOOR_MS;
    expect(staleLoops()).toEqual([]);
    at = LIVENESS_FLOOR_MS + 1;
    expect(staleLoops()).toEqual([
      {
        name: 'worker',
        reason: 'silent',
        ageMs: LIVENESS_FLOOR_MS + 1,
        boundMs: LIVENESS_FLOOR_MS,
      },
    ]);
    beat.stamp();
    expect(staleLoops()).toEqual([]);
  });

  test('a pass held open past the bound is stale even while the timer side keeps stamping', () => {
    const beat = begin('replicator', 10_000, false);
    const leave = beat.enter();
    at = LIVENESS_FLOOR_MS + 5;
    beat.stamp();
    expect(staleLoops().map((loop) => [loop.name, loop.reason, loop.ageMs])).toEqual([
      ['replicator', 'held', LIVENESS_FLOOR_MS + 5],
    ]);
    leave();
    leave(); // idempotent: a second leave never forgets another pass
    expect(staleLoops()).toEqual([]);
  });

  test('an event-driven loop with nothing to do is never stale', () => {
    begin('replicator', 10_000, false);
    at = 10 * LIVENESS_FLOOR_MS;
    expect(staleLoops()).toEqual([]);
  });

  test('a stopped loop is not judged, and start stamps afresh', () => {
    const beat = begin('worker', 250);
    beat.stop();
    at = 10 * LIVENESS_FLOOR_MS;
    expect(staleLoops()).toEqual([]);
    beat.start();
    expect(staleLoops()).toEqual([]);
    at += LIVENESS_FLOOR_MS + 1;
    expect(staleLoops()).toHaveLength(1);
  });

  test('a non-finite tick is refused where the heartbeat is built', () => {
    expect(() => loopHeartbeat('worker', { tickMs: Number.NaN })).toThrow(/tickMs/);
  });
});
