// `keptAnswer` and `throttledNotify` on their own: the identity rule a renderer stops on, and the
// leading-and-trailing period with no clock.

import { describe, expect, test } from 'bun:test';
import type { AsyncState } from '@ultimat3/core/page';
import { keptAnswer, sameRows, throttledNotify } from './record-answer';

/** An answer's rows, or `undefined` while pending or failed — what identity is asserted on. */
const dataOf = <R>(answer: AsyncState<R>): R | undefined =>
  answer.status === 'ready' || answer.status === 'refreshing' ? answer.data : undefined;

describe('keptAnswer', () => {
  test('the previous answer back when status and row objects match, a new one otherwise', () => {
    const a = { id: 'a' };
    const b = { id: 'b' };
    const first = keptAnswer(null, 'ready', [a, b]);
    expect(keptAnswer(first, 'ready', [a, b])).toBe(first);
    const refreshing = keptAnswer(first, 'refreshing', [a, b]);
    expect(refreshing).not.toBe(first);
    expect(dataOf(refreshing)).toBe(dataOf(first));
    // An equal row that is another object is a move: the store keeps an unmoved row's object.
    expect(keptAnswer(first, 'ready', [a, { id: 'b' }])).not.toBe(first);
    expect(keptAnswer(first, 'ready', [b, a])).not.toBe(first);
    expect(keptAnswer({ status: 'pending' }, 'ready', [])).toEqual({ status: 'ready', data: [] });
  });

  test('sameRows compares by element identity and length', () => {
    const a = { id: 'a' };
    expect(sameRows([a], [a])).toBe(true);
    expect(sameRows([a], [a, a])).toBe(false);
    expect(sameRows([a], [{ id: 'a' }])).toBe(false);
  });
});

describe('throttledNotify', () => {
  test('absent or 0 is every change, synchronously, with no timer', () => {
    let told = 0;
    const armed: number[] = [];
    for (const ms of [undefined, 0]) {
      const notifier = throttledNotify(
        () => told++,
        ms,
        (_, after) => {
          armed.push(after);
          return () => undefined;
        },
      );
      notifier.call();
      notifier.call();
    }
    expect(told).toBe(4);
    expect(armed).toEqual([]);
  });

  test('a period with nothing owed closes; one with a change owed tells it and opens the next', () => {
    let told = 0;
    const timers: (() => void)[] = [];
    const notifier = throttledNotify(
      () => told++,
      100,
      (fn) => {
        timers.push(fn);
        return () => undefined;
      },
    );
    notifier.call();
    expect([told, timers.length]).toEqual([1, 1]);
    notifier.call();
    notifier.call();
    timers.shift()?.();
    expect([told, timers.length]).toEqual([2, 1]);
    timers.shift()?.();
    expect([told, timers.length]).toEqual([2, 0]);
    notifier.call();
    expect(told).toBe(3);
  });

  test('a reader that releases while it is told leaves no timer armed, now or at the period end', () => {
    const armed = new Set<() => void>();
    const notifier = throttledNotify(
      () => notifier.cancel(),
      100,
      (fn) => {
        armed.add(fn);
        return () => armed.delete(fn);
      },
    );
    notifier.call();
    expect(armed.size).toBe(0);
    notifier.call();
    expect(armed.size).toBe(0);
  });

  test('a release inside the trailing notification arms no next period', () => {
    const armed = new Set<() => void>();
    let released = false;
    const notifier = throttledNotify(
      () => {
        if (released) notifier.cancel();
      },
      100,
      (fn) => {
        armed.add(fn);
        return () => armed.delete(fn);
      },
    );
    notifier.call();
    notifier.call();
    released = true;
    const [fire] = [...armed];
    armed.clear();
    fire?.();
    expect(armed.size).toBe(0);
  });
});
