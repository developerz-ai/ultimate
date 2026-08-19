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
});
