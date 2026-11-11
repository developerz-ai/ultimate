// The island build's pool: bounded, ordered, and stopped by its first failure — in `x dev` a
// syntax error in one island must not leave the other groups bundling into the next generation.

import { describe, expect, test } from 'bun:test';
import { boundedMap } from './island-build-pool';

/** A promise the test settles, typed here: the test typecheck has no `PromiseWithResolvers`. */
interface Gate {
  readonly promise: Promise<void>;
  readonly open: () => void;
}

const gate = (): Gate => {
  const { promise, resolve } = Promise.withResolvers<void>();
  return { promise, open: () => resolve() };
};

/** One full event-loop turn: every microtask the pool chains behind a settled item has run. */
const turn = (): Promise<void> => Bun.sleep(0);

describe('boundedMap', () => {
  test('answers in item order, never more than `width` at a time', async () => {
    const gates = [gate(), gate(), gate(), gate()];
    const started: number[] = [];
    let running = 0;
    let peak = 0;
    const out = boundedMap([0, 1, 2, 3], 2, async (n) => {
      started.push(n);
      running += 1;
      peak = Math.max(peak, running);
      await gates[n]?.promise;
      running -= 1;
      return n * 10;
    });
    await turn();
    expect(started).toEqual([0, 1]);
    // Settled out of item order: the answer must still be in item order.
    gates[1]?.open();
    await turn();
    expect(started).toEqual([0, 1, 2]);
    gates[2]?.open();
    await turn();
    expect(started).toEqual([0, 1, 2, 3]);
    gates[3]?.open();
    gates[0]?.open();
    expect(await out).toEqual([0, 10, 20, 30]);
    expect(peak).toBe(2);
  });

  test('after the first rejection no new item starts, and the rejection is the answer', async () => {
    const started: number[] = [];
    const inFlight = gate();
    const items = Array.from({ length: 10 }, (_, index) => index);
    const run = boundedMap(items, 3, async (n) => {
      started.push(n);
      if (n === 0) return Promise.reject(new TypeError('island 0 did not bundle'));
      await inFlight.promise;
      return n;
    });
    await expect(run).rejects.toThrow('island 0 did not bundle');
    // The two already in flight beside it finish; nothing after them begins.
    inFlight.open();
    await turn();
    expect(started).toEqual([0, 1, 2]);
  });

  test('no items, no workers', async () => {
    expect(await boundedMap([], 4, async () => expect.unreachable('ran with no items'))).toEqual(
      [],
    );
  });
});
