import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { differenceMs, epoch, fromIso, instant, isInstant, now, toIso } from './instant';

describe('instant', () => {
  test('round-trips ISO-8601 in UTC', () => {
    expect(toIso(fromIso('2026-03-14T09:00:00+01:00'))).toBe('2026-03-14T08:00:00.000Z');
    expect(toIso(fromIso('2026-03-14T08:00:00Z'))).toBe('2026-03-14T08:00:00.000Z');
  });

  test('rejects an unparseable timestamp with X_INSTANT_INVALID', () => {
    expect(codeOf(() => fromIso('14/03/2026'))).toBe('X_INSTANT_INVALID');
    expect(codeOf(() => fromIso(''))).toBe('X_INSTANT_INVALID');
  });

  test('takes its clock by injection, so tests can freeze time', () => {
    const frozen: Clock = { now: () => new Date('2026-03-14T08:00:00Z') };
    expect(toIso(now(frozen))).toBe('2026-03-14T08:00:00.000Z');
    expect(differenceMs(now(frozen), fromIso('2026-03-14T09:00:00Z'))).toBe(3_600_000);
  });

  test('wraps an untrusted Date by copying it, never by branding the callers own object', () => {
    // `value as Instant` handed back the caller's object, still `setTime()`-able after the brand.
    const caller = new Date('2026-03-14T09:00:00Z');
    const wrapped = instant(caller);
    caller.setTime(0);
    expect(toIso(wrapped)).toBe('2026-03-14T09:00:00.000Z');
  });

  test('epoch() is a fresh instant, so one consumer cannot corrupt it for the process', () => {
    // A shared mutable `Date` exported from a tier-1 package is one `setUTCFullYear` away from
    // being wrong for every other consumer, permanently and silently.
    const first = epoch();
    expect(toIso(first)).toBe('1970-01-01T00:00:00.000Z');
    first.setUTCFullYear(1999);
    expect(toIso(epoch())).toBe('1970-01-01T00:00:00.000Z');
  });

  test('guards untrusted values', () => {
    expect(isInstant(new Date('2026-03-14T08:00:00Z'))).toBe(true);
    expect(isInstant(new Date('nope'))).toBe(false);
    expect(isInstant('2026-03-14T08:00:00Z')).toBe(false);
    expect(isInstant(null)).toBe(false);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}
