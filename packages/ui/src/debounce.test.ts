// Real timers, small windows: a debounce that is tested against a mocked clock proves the mock,
// not the timer. Every case leaves nothing scheduled — a leaked timer is the actual bug here.

import { describe, expect, test } from 'bun:test';
import { debounce } from './debounce';
import { UI_ERROR_CODES, UiError } from './errors';

const WINDOW = 10;
const QUIET = 40;

/**
 * A loaded runner fires a 10ms timer far later than 10ms, so a call that IS expected is polled for
 * rather than bet on a fixed sleep covering the window — that bet is what went red on CI, with two
 * chained windows landing past a 40ms budget. A call that is NOT expected still needs a real wait,
 * and `QUIET` is that one: waiting longer there only makes the assertion stricter.
 */
const waitFor = async (done: () => boolean, polls = 200): Promise<void> => {
  for (let poll = 0; poll < polls && !done(); poll += 1) await Bun.sleep(5);
};

describe('debounce', () => {
  test('only the last call of a burst runs, with its own arguments', async () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => seen.push(query), WINDOW);

    filter('a');
    filter('ab');
    filter('abc');
    expect(seen).toEqual([]);

    await waitFor(() => seen.length > 0);
    expect(seen).toEqual(['abc']);
    expect(filter.pending()).toBe(false);
  });

  test('a second burst runs again — the timer is not one-shot', async () => {
    let calls = 0;
    const tick = debounce(() => {
      calls += 1;
    }, WINDOW);

    tick();
    await waitFor(() => calls > 0);
    tick();
    await waitFor(() => calls > 1);
    expect(calls).toBe(2);
  });

  test('cancel drops the pending call and leaves nothing scheduled', async () => {
    let calls = 0;
    const tick = debounce(() => {
      calls += 1;
    }, WINDOW);

    tick();
    expect(tick.pending()).toBe(true);
    tick.cancel();
    expect(tick.pending()).toBe(false);

    await Bun.sleep(QUIET);
    expect(calls).toBe(0);
  });

  test('flush runs the pending call now, and only once', async () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => seen.push(query), WINDOW);

    filter('now');
    filter.flush();
    expect(seen).toEqual(['now']);

    await Bun.sleep(QUIET);
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

  test('a handler that re-queues keeps its next call', async () => {
    const seen: string[] = [];
    const filter = debounce((query: string) => {
      seen.push(query);
      if (query === 'first') filter('second');
    }, WINDOW);

    filter('first');
    await waitFor(() => seen.length > 1);
    expect(seen).toEqual(['first', 'second']);
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
