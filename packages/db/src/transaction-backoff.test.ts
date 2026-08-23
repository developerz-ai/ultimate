// The wait a lost serialization race takes before re-running: the exact schedule, and the two
// constants it is built from. Pure — the loop that consumes it is `transaction-retry.test.ts`.

import { describe, expect, test } from 'bun:test';
import { serializationRetryDelayMs, TRANSACTION_RETRY_BACKOFF } from './transaction-backoff';

const attempts = [1, 2, 3, 4, 5, 6, 7, 8];

describe('serializationRetryDelayMs', () => {
  test('doubles from the base and stops at the ceiling', () => {
    // The roll is injected, so this is a list and not a range. At 1 the full-jitter pick IS the
    // ceiling, which makes the curve itself readable.
    expect(attempts.map((attempt) => serializationRetryDelayMs(attempt, () => 1))).toEqual([
      10, 20, 40, 80, 160, 320, 500, 500,
    ]);
  });

  test('the clamp lands BEFORE the jitter, so the tail is a distribution and not one value', () => {
    // Capping after the roll would make every attempt past the 6th answer exactly 500 at roll 1 and
    // exactly 500 at roll 0.9 — the correlation the jitter exists to remove.
    expect(attempts.map((attempt) => serializationRetryDelayMs(attempt, () => 0.5))).toEqual([
      5, 10, 20, 40, 80, 160, 250, 250,
    ]);
  });

  test('full jitter, so a roll of 0 waits nothing at all', () => {
    expect(serializationRetryDelayMs(4, () => 0)).toBe(0);
  });

  test('the constants are a short base and a bounded ceiling, and stay that way', () => {
    // A serialization conflict is CONTENTION, not overload: the writer that won is already
    // committing, so the wait that clears it is milliseconds. A provider-outage base (500ms) would
    // put a request's own retry budget seconds past the deadline it was serving.
    expect(TRANSACTION_RETRY_BACKOFF.base).toBe(10);
    expect(TRANSACTION_RETRY_BACKOFF.max).toBe(500);
    expect(TRANSACTION_RETRY_BACKOFF.jitter).toBe('full');
  });
});
