// The cut-off's arithmetic: measured back from where core's in-flight wait ends
// (`ShutdownReason.inflightUntil`), so a job told to stop has the margin to unwind before that wait
// gives up — never the same instant, which a nack's round trip loses (`X_SHUTDOWN_TIMEOUT`, exit 70).

import { describe, expect, test } from 'bun:test';
import { cutoffTimes, DRAIN_CANCEL_MARGIN_MS } from './worker-drain-cutoff';

describe('cutoffTimes', () => {
  test('with no in-flight end, the margin is measured back from the deadline', () => {
    expect(cutoffTimes(10_000, 0)).toEqual({ cancelAt: 8_000, handBackAt: 9_000 });
  });

  test('the hand-back lands a margin before the in-flight wait ends, not at it', () => {
    const times = cutoffTimes(10_000, 0, 8_000);
    expect(times).toEqual({ cancelAt: 6_000, handBackAt: 7_000 });
    expect(8_000 - times.cancelAt).toBe(DRAIN_CANCEL_MARGIN_MS);
  });

  test('a small budget still keeps half of what is left before the wait ends', () => {
    expect(cutoffTimes(300, 0, 240)).toEqual({ cancelAt: 120, handBackAt: 180 });
  });

  test('an in-flight end past the deadline is the deadline', () => {
    expect(cutoffTimes(10_000, 0, 12_000)).toEqual(cutoffTimes(10_000, 0));
  });
});
