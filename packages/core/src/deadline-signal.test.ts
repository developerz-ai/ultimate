// The undoable deadline signal, moved here from `@ultimat3/scraping` for `outbound()`: a deadline
// aborts as a timeout, the outer signal as itself, and disposing lets both go without aborting.

import { describe, expect, test } from 'bun:test';
import { deadlineSignal, platformDeadlineTimer } from './deadline-signal';
import { manualTimer } from './outbound-fixture';

describe('unit · deadlineSignal', () => {
  test('the deadline aborts as a TimeoutError; the outer signal aborts with its own reason', () => {
    const timer = manualTimer();
    const outer = new AbortController();
    using timed = deadlineSignal(1_000, outer.signal, timer);
    timer.fire(1_000);
    expect([timed.signal.aborted, timed.timedOut()]).toEqual([true, true]);
    expect((timed.signal.reason as DOMException).name).toBe('TimeoutError');

    const cancelled = deadlineSignal(1_000, outer.signal, manualTimer());
    outer.abort('cancelled');
    expect([cancelled.timedOut(), cancelled.signal.reason]).toEqual([false, 'cancelled']);
    cancelled[Symbol.dispose]();
  });

  test('an outer signal already aborted aborts at once', () => {
    const outer = new AbortController();
    outer.abort('gone');
    using composed = deadlineSignal(1_000, outer.signal, manualTimer());
    expect(composed.signal.reason).toBe('gone');
  });

  test('dispose clears the timer, never aborts, and is idempotent', () => {
    const timer = manualTimer();
    const live = deadlineSignal(1_000, undefined, timer);
    live[Symbol.dispose]();
    live[Symbol.dispose]();
    expect([timer.armed(), live.signal.aborted]).toEqual([[], false]);
  });

  test('the platform timer arms and clears a real timeout', () => {
    let fired = false;
    platformDeadlineTimer.clear(platformDeadlineTimer.set(() => (fired = true), 60_000));
    expect(fired).toBe(false);
  });
});
