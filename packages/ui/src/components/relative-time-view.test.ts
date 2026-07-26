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

  test('sub-second deltas read as now, not as "0 seconds ago"', () => {
    expect(relativeTimeText({ value: NOW, locale: 'en', now: NOW })).toBe('now');
  });
});
