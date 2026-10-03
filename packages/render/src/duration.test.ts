import { describe, expect, test } from 'bun:test';
import { parseTtlMs } from './duration';

describe('parseTtlMs', () => {
  test('parses duration strings and passes milliseconds through', () => {
    expect(parseTtlMs('5m')).toBe(300_000);
    expect(parseTtlMs('1h')).toBe(3_600_000);
    expect(parseTtlMs(1500)).toBe(1500);
    expect(parseTtlMs('soon')).toBe(null);
    expect(parseTtlMs(undefined)).toBe(null);
  });

  // The shapes an author writes when they mean a duration and the regex does not: each one is a
  // TTL that never ticks, so every reader has to see the same `null`.
  test('answers null for a spelling that looks like a duration and is not', () => {
    for (const ttl of ['5 minutes', '5min', '5', '', 'PT5M', '-5m', '5m ago']) {
      expect(parseTtlMs(ttl)).toBe(null);
    }
  });

  test('answers null for a number that cannot be a duration', () => {
    expect(parseTtlMs(0)).toBe(null);
    expect(parseTtlMs(-1)).toBe(null);
    expect(parseTtlMs(Number.NaN)).toBe(null);
    expect(parseTtlMs(Number.POSITIVE_INFINITY)).toBe(null);
  });

  // The string arm agrees with the number arm: a zero-length TTL is no TTL, in every unit.
  test('answers null for a zero duration in any unit, as the number arm does for 0', () => {
    for (const ttl of ['0s', '0ms', '0m', '0h', '0d', '0.0s', '00m']) {
      expect(parseTtlMs(ttl)).toBe(null);
    }
    expect(parseTtlMs('0.5s')).toBe(500);
  });

  // A JS caller's `revalidate: { ttl: true }` reached `.trim()`: the one reader is total.
  test('answers null for a value that is neither a string nor a number', () => {
    for (const ttl of [true, {}, [], 5n]) expect(parseTtlMs(ttl as never)).toBe(null);
  });
});
