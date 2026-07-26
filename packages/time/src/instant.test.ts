import { describe, expect, test } from 'bun:test';
import type { Clock } from '@ultimat3/core';
import { differenceMs, fromIso, isInstant, now, toIso } from './instant';

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
