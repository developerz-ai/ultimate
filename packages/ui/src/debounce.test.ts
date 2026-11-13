// Bun's fake timers: the subject arms the runtime's own `setTimeout` and the test moves the clock,
// so a window is asserted to the millisecond and nothing waits on the wall. Every case leaves
// nothing scheduled — `jest.getTimerCount()` reads it directly; a leaked timer is the bug here.

import { afterEach, beforeEach, describe, expect, jest, test } from 'bun:test';
import { debounce } from './debounce';
import { UI_ERROR_CODES, UiError } from './errors';

const WINDOW = 10;

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('debounce', () => {
  test('only the last call of a burst runs, with its own arguments, a window after it', () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => seen.push(query), WINDOW);

    filter('a');
    jest.advanceTimersByTime(WINDOW - 1);
    filter('ab');
    jest.advanceTimersByTime(WINDOW - 1);
    filter('abc');
    // The window restarts on every call: a millisecond short of it, still nothing.
    jest.advanceTimersByTime(WINDOW - 1);
    expect(seen).toEqual([]);

    jest.advanceTimersByTime(1);
    expect(seen).toEqual(['abc']);
    expect(filter.pending()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('a second burst runs again — the timer is not one-shot', () => {
    let calls = 0;
    const tick = debounce(() => {
      calls += 1;
    }, WINDOW);

    tick();
    jest.advanceTimersByTime(WINDOW);
    expect(calls).toBe(1);
    tick();
    jest.advanceTimersByTime(WINDOW);
    expect(calls).toBe(2);
  });

  test('cancel drops the pending call and leaves nothing scheduled', () => {
    let calls = 0;
    const tick = debounce(() => {
      calls += 1;
    }, WINDOW);

    tick();
    expect(tick.pending()).toBe(true);
    tick.cancel();
    expect(tick.pending()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(WINDOW * 4);
    expect(calls).toBe(0);
  });

  test('flush runs the pending call now, and only once', () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => seen.push(query), WINDOW);

    filter('now');
    filter.flush();
    expect(seen).toEqual(['now']);
    expect(jest.getTimerCount()).toBe(0);

    jest.advanceTimersByTime(WINDOW * 4);
    expect(seen).toEqual(['now']);
  });

  test('flush with nothing pending is a no-op', () => {
    let calls = 0;
    const tick = debounce(() => {
      calls += 1;
    }, WINDOW);
    tick.flush();
    expect(calls).toBe(0);
  });

  test('a handler that re-queues keeps its next call', () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => {
      seen.push(query);
      if (query === 'first') filter('second');
    }, WINDOW);

    filter('first');
    jest.advanceTimersByTime(WINDOW);
    expect(seen).toEqual(['first']);
    jest.advanceTimersByTime(WINDOW);
    expect(seen).toEqual(['first', 'second']);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('an impossible delay is a UiError, not a silent immediate call', () => {
    expect(() => debounce(() => {}, -1)).toThrow(UiError);
    expect(() => debounce(() => {}, Number.NaN)).toThrow(/finite, non-negative/);
    try {
      debounce(() => {}, -1);
    } catch (error) {
      expect((error as UiError).code).toBe(UI_ERROR_CODES.invalidValue);
    }
  });
});
