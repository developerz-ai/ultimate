// The reporting seam is core's, so what this package has to prove is the part core does not do:
// the rate limit, keyed per flag and on the monotonic clock, and the laziness that keeps a
// rate-limited call off the hot path.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { MemoryErrorReporter, UltimateError } from '@ultimat3/core';
import {
  UltimateError as CoreError,
  configureErrorReporting,
  frozenClock,
  memoryErrorReporter,
  resetErrorReporting,
} from '@ultimat3/core';
import {
  configureFlags,
  DEFAULT_REPORT_INTERVAL_MS,
  reportOnce,
  resetFlagReporting,
} from './runtime';

const build = (): UltimateError =>
  new CoreError({ code: 'X_FLAG_EXPIRED', cause: 'overdue', fix: 'x flags --json' });

let sink: MemoryErrorReporter;

beforeEach(() => {
  sink = memoryErrorReporter();
  resetErrorReporting();
  resetFlagReporting();
  configureErrorReporting({ reporter: sink });
});

afterEach(() => {
  resetErrorReporting();
  resetFlagReporting();
});

describe('unit · the reporting seam', () => {
  test('reports through core, so an app wires its monitor in exactly one place', () => {
    expect(reportOnce('a.flag', build)).toBe(true);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.code).toBe('X_FLAG_EXPIRED');
  });

  test('is a warning from the process, not an error on whichever request touched it', () => {
    reportOnce('a.flag', build);
    expect(sink.events[0]?.severity).toBe('warning');
    expect(sink.events[0]?.source).toBe('process');
    expect(sink.events[0]?.scope.operation).toBe('a.flag');
  });

  test('the default interval is an hour — often enough to see, rare enough not to mute', () => {
    expect(DEFAULT_REPORT_INTERVAL_MS).toBe(3_600_000);
  });
});

describe('unit · reportOnce', () => {
  test('rate-limits per key, so two overdue flags are two reports', () => {
    configureFlags({ clock: frozenClock(0), reportEveryMs: 1_000 });
    expect(reportOnce('a.flag', build)).toBe(true);
    expect(reportOnce('a.flag', build)).toBe(false);
    expect(reportOnce('b.flag', build)).toBe(true);
    expect(sink.events).toHaveLength(2);
  });

  test('does not even build the error while it is rate-limited', () => {
    configureFlags({ clock: frozenClock(0), reportEveryMs: 1_000 });
    let built = 0;
    const counting = (): UltimateError => {
      built += 1;
      return build();
    };
    reportOnce('a.flag', counting);
    reportOnce('a.flag', counting);
    reportOnce('a.flag', counting);
    expect(built).toBe(1);
  });

  test('a wall-clock jump does not reopen the window — the limit is monotonic', () => {
    const clock = frozenClock('2026-03-05T00:00:00.000Z');
    configureFlags({ clock, reportEveryMs: 60_000 });
    reportOnce('a.flag', build);
    // `set` moves wall-clock time only; monotonic time is untouched, which is exactly an NTP
    // correction or a container resuming.
    clock.set('2020-01-01T00:00:00.000Z');
    expect(reportOnce('a.flag', build)).toBe(false);
    clock.set('2030-01-01T00:00:00.000Z');
    expect(reportOnce('a.flag', build)).toBe(false);
    expect(sink.events).toHaveLength(1);
  });

  test('resetFlagReporting puts the system clock and the default interval back', () => {
    configureFlags({ clock: frozenClock(0), reportEveryMs: 1 });
    reportOnce('a.flag', build);
    resetFlagReporting();
    expect(reportOnce('a.flag', build)).toBe(true);
    expect(reportOnce('a.flag', build)).toBe(false);
    expect(sink.events).toHaveLength(2);
  });
});

// F6. `resetFlagReporting` clears the map; `configureFlags` is what apps and test kits actually
// call, and it swapped the clock underneath a watermark measured against the OLD one.
describe('unit · swapping the clock', () => {
  test('a fresh clock does not inherit the previous clock monotonic watermark', () => {
    // A long-lived process reports at monotonic 10_000_000. A test kit — or a second
    // `configureFlags` at boot — then installs a clock that starts at 0. `now - previous` is
    // -10_000_000, which is below every interval, so this flag could never report again until the
    // new clock passed the old one's reading: on a frozen test clock, never.
    const running = frozenClock(0);
    running.advance(10_000_000);
    configureFlags({ clock: running, reportEveryMs: 1_000 });
    expect(reportOnce('a.flag', build)).toBe(true);

    configureFlags({ clock: frozenClock(0) });
    expect(reportOnce('a.flag', build)).toBe(true);
    expect(sink.events).toHaveLength(2);
  });

  test('the rate limit still holds within one clock', () => {
    const clock = frozenClock(0);
    configureFlags({ clock, reportEveryMs: 1_000 });
    expect(reportOnce('a.flag', build)).toBe(true);
    expect(reportOnce('a.flag', build)).toBe(false);
    clock.advance(1_000);
    expect(reportOnce('a.flag', build)).toBe(true);
  });

  test('re-configuring only the interval keeps the window it already opened', () => {
    // The watermark is only stale when the CLOCK changes. An interval change re-reads the same
    // clock, so clearing there would let a report through on every configure call.
    const clock = frozenClock(0);
    configureFlags({ clock, reportEveryMs: 1_000 });
    expect(reportOnce('a.flag', build)).toBe(true);
    configureFlags({ reportEveryMs: 5_000 });
    expect(reportOnce('a.flag', build)).toBe(false);
  });
});
