import { describe, expect, test } from 'bun:test';
import { relativeTimeText } from './relative-time-view';

const NOW = '2026-07-26T12:00:00.000Z';

describe('relativeTimeText', () => {
  test('picks the largest fitting unit in both directions', () => {
    expect(relativeTimeText({ value: '2026-07-26T11:58:00.000Z', locale: 'en', now: NOW })).toBe(
      '2 minutes ago',
    );
    expect(relativeTimeText({ value: '2026-07-28T12:00:00.000Z', locale: 'en', now: NOW })).toBe(
      'in 2 days',
    );
    expect(relativeTimeText({ value: '2025-07-26T12:00:00.000Z', locale: 'en', now: NOW })).toBe(
      'last year',
    );
  });

  test('uses the injected locale, not an ambient one', () => {
    const args = { value: '2026-07-26T11:00:00.000Z', now: NOW } as const;
    expect(relativeTimeText({ ...args, locale: 'en' })).toBe('1 hour ago');
    expect(relativeTimeText({ ...args, locale: 'de' })).toBe('vor 1 Stunde');
  });

  test('a value that ROUNDS to the next unit is promoted to it — never "60 minutes ago"', () => {
    const at = (ms: number): string => new Date(Date.parse(NOW) + ms).toISOString();
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    const cases: readonly (readonly [number, string])[] = [
      [-59.6 * 1000, '1 minute ago'],
      [-59.6 * minute, '1 hour ago'],
      [-23.6 * hour, 'yesterday'],
      [-6.6 * day, 'last week'],
      [59.6 * minute, 'in 1 hour'],
      // Below the half-way mark nothing moves.
      [-59.4 * minute, '59 minutes ago'],
    ];
    for (const [delta, text] of cases) {
      expect(relativeTimeText({ value: at(delta), locale: 'en', now: NOW })).toBe(text);
    }
  });

  test('sub-second deltas read as now, not as "0 seconds ago"', () => {
    expect(relativeTimeText({ value: NOW, locale: 'en', now: NOW })).toBe('now');
  });
});
