// Pins mapBounded's contract: never more than `width` in flight, results in input order, the first
// rejection (or the caller's abort) stops every item not yet started, and a bad width is coded.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from './errors';
import type { MapBoundedOptions } from './map-bounded';
import { mapBounded } from './map-bounded';

/** A promise the test settles by hand, so "in flight" is a fact rather than a timing guess. */
function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Drains the microtask queue so every runner has pulled what it is going to pull. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (caught) {
    return caught;
  }
  return expect.unreachable('mapBounded resolved where it had to reject');
}

describe('mapBounded', () => {
  test('never runs more than width at once, and fills every freed slot', async () => {
    const gates = Array.from({ length: 10 }, () => deferred<number>());
    let inFlight = 0;
    let peak = 0;
    const started: number[] = [];
    const run = mapBounded(
      gates,
      async (gate, index) => {
        started.push(index);
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        const value = await gate.promise;
        inFlight -= 1;
        return value;
      },
      { width: 3 },
    );
    await settle();
    expect(started).toEqual([0, 1, 2]);
    for (const [index, gate] of gates.entries()) {
      gate.resolve(index);
      await settle();
    }
    expect(await run).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(peak).toBe(3);
  });

  test('answers in input order when the work finishes in reverse', async () => {
    const gates = Array.from({ length: 5 }, () => deferred<string>());
    const run = mapBounded(gates, (gate) => gate.promise, { width: 5 });
    await settle();
    for (let index = gates.length - 1; index >= 0; index -= 1) gates[index]?.resolve(`v${index}`);
    expect(await run).toEqual(['v0', 'v1', 'v2', 'v3', 'v4']);
  });

  test('an empty list answers [] and calls nothing', async () => {
    let calls = 0;
    expect(await mapBounded([], () => (calls += 1), { width: 4 })).toEqual([]);
    expect(calls).toBe(0);
  });

  test('the first rejection aborts the rest: nothing new starts, in-flight work hears it', async () => {
    const boom = new TypeError('item 1 failed');
    const heard: unknown[] = [];
    const started: number[] = [];
    const slow = deferred<number>();
    const run = mapBounded(
      [0, 1, 2, 3, 4, 5],
      async (item, index, signal) => {
        started.push(index);
        if (item === 1) throw boom;
        signal.addEventListener('abort', () => heard.push(signal.reason));
        return slow.promise;
      },
      { width: 2 },
    );
    expect(await rejection(run)).toBe(boom);
    slow.resolve(0);
    await settle();
    expect(started).toEqual([0, 1]);
    expect(heard).toEqual([boom]);
  });

  test('a synchronous throw is a rejection too, not an escape', async () => {
    const boom = new RangeError('sync');
    const run = mapBounded(
      [1],
      () => {
        throw boom;
      },
      { width: 1 },
    );
    expect(await rejection(run)).toBe(boom);
  });

  test("the caller's signal stops every item not yet started, as X_ABORTED", async () => {
    const caller = new AbortController();
    const started: number[] = [];
    const gates = Array.from({ length: 4 }, () => deferred<number>());
    let inner: AbortSignal | undefined;
    const run = mapBounded(
      gates,
      (gate, index, signal) => {
        started.push(index);
        inner = signal;
        return gate.promise;
      },
      { width: 1, signal: caller.signal },
    );
    await settle();
    caller.abort(new Error('deadline'));
    const caught = await rejection(run);
    if (!isUltimateError(caught)) return expect.unreachable('the abort was not coded');
    expect(caught.code).toBe('X_ABORTED');
    expect(caught.cause).toContain('0 of 4');
    expect(inner?.aborted).toBe(true);
    gates[0]?.resolve(0);
    await settle();
    expect(started).toEqual([0]);
  });

  test('a signal already aborted starts nothing', async () => {
    let calls = 0;
    const caught = await rejection(
      mapBounded([1, 2], () => (calls += 1), { width: 2, signal: AbortSignal.abort() }),
    );
    expect(isUltimateError(caught) ? caught.code : 'not coded').toBe('X_ABORTED');
    expect(calls).toBe(0);
  });

  test.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['missing', undefined],
  ])('refuses a %s width with X_INVARIANT before calling anything', async (_label, width) => {
    let calls = 0;
    const caught = await rejection(
      mapBounded([1, 2], () => (calls += 1), { width: width as number }),
    );
    if (!isUltimateError(caught)) return expect.unreachable('a bad width was not coded');
    expect(caught.code).toBe('X_INVARIANT');
    expect(caught.cause).toContain('mapBounded width');
    expect(calls).toBe(0);
  });

  describe("settle: 'all'", () => {
    test('answers every outcome in input order; a rejection pulls the next item', async () => {
      const boom = new TypeError('item 1 failed');
      const gates = Array.from({ length: 4 }, () => deferred<string>());
      const started: number[] = [];
      const run = mapBounded(
        gates,
        (gate, index) => {
          started.push(index);
          return gate.promise;
        },
        { width: 2, settle: 'all' },
      );
      await settle();
      expect(started).toEqual([0, 1]);
      gates[1]?.reject(boom);
      await settle();
      expect(started).toEqual([0, 1, 2]);
      gates[3]?.resolve('v3');
      gates[2]?.resolve('v2');
      await settle();
      gates[0]?.resolve('v0');
      expect(await run).toEqual([
        { status: 'fulfilled', value: 'v0' },
        { status: 'rejected', reason: boom },
        { status: 'fulfilled', value: 'v2' },
        { status: 'fulfilled', value: 'v3' },
      ]);
    });

    test('honours width while failures free slots, and never aborts a sibling', async () => {
      let inFlight = 0;
      let peak = 0;
      const signals: AbortSignal[] = [];
      const failed = new RangeError('a multiple of three, or four');
      const outcomes = await mapBounded(
        Array.from({ length: 9 }, (_, index) => index),
        async (item, _index, signal) => {
          signals.push(signal);
          inFlight += 1;
          peak = Math.max(peak, inFlight);
          await settle();
          inFlight -= 1;
          if (item % 3 === 0 || item === 4) throw failed;
          return item * 10;
        },
        { width: 3, settle: 'all' },
      );
      expect(peak).toBe(3);
      expect(outcomes.map((outcome) => outcome.status)).toEqual([
        'rejected',
        'fulfilled',
        'fulfilled',
        'rejected',
        'rejected',
        'fulfilled',
        'rejected',
        'fulfilled',
        'fulfilled',
      ]);
      expect(signals.some((signal) => signal.aborted)).toBe(false);
    });

    test('a synchronous throw is recorded as that item, not an escape', async () => {
      const boom = new RangeError('sync');
      const outcomes = await mapBounded(
        [1, 2],
        (item) => {
          if (item === 1) throw boom;
          return item;
        },
        { width: 1, settle: 'all' },
      );
      expect(outcomes).toEqual([
        { status: 'rejected', reason: boom },
        { status: 'fulfilled', value: 2 },
      ]);
    });

    test("the caller's signal still aborts everything, as X_ABORTED", async () => {
      const caller = new AbortController();
      const started: number[] = [];
      const gates = Array.from({ length: 4 }, () => deferred<number>());
      let inner: AbortSignal | undefined;
      const run = mapBounded(
        gates,
        (gate, index, signal) => {
          started.push(index);
          inner = signal;
          return gate.promise;
        },
        { width: 1, signal: caller.signal, settle: 'all' },
      );
      gates[0]?.reject(new TypeError('first failed'));
      await settle();
      expect(started).toEqual([0, 1]);
      caller.abort(new Error('deadline'));
      const caught = await rejection(run);
      if (!isUltimateError(caught)) return expect.unreachable('the abort was not coded');
      expect(caught.code).toBe('X_ABORTED');
      expect(caught.cause).toContain('1 of 4');
      expect(inner?.aborted).toBe(true);
      gates[1]?.resolve(1);
      await settle();
      expect(started).toEqual([0, 1]);
    });

    test('an empty list answers []', async () => {
      expect(await mapBounded([], () => 1, { width: 2, settle: 'all' })).toEqual([]);
    });
  });

  // The type IS the assertion here (`scripts/test-typecheck-gate.ts` compiles this file): 31.23's
  // call shape — options held in a value typed `MapBoundedOptions` — matched no overload in 31.24
  // (TS2769), and this stops compiling if the overload for it goes.
  describe('a value typed MapBoundedOptions, the 31.23 call shape', () => {
    test('compiles, answers in input order, and a literal settle keeps its exact type', async () => {
      const options: MapBoundedOptions = { width: 2 };
      const wide: number[] | PromiseSettledResult<number>[] = await mapBounded(
        [1, 2],
        async (n) => n * 10,
        options,
      );
      expect(wide).toEqual([10, 20]);
      const exact: number[] = await mapBounded([3], (n) => n, { width: 1 });
      expect(exact).toEqual([3]);
    });
  });
});
