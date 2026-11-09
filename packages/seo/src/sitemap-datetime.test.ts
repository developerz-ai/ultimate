// A sitemap `lastmod` is one instant or none: an impossible calendar day is none, never the day
// `Date.parse` rolls it over into.

import { describe, expect, test } from 'bun:test';
import { sitemapDatetime } from './sitemap-datetime';

const NOW = new Date('2026-11-01T00:00:00Z');

describe('sitemapDatetime', () => {
  test.each(['2026-02-30', '2026-04-31', '2025-02-29', '2026-13-01', '2026-02-30T10:00:00Z'])(
    '%s names no day, so it is no lastmod',
    (value) => {
      expect(sitemapDatetime(value, NOW)).toBeUndefined();
    },
  );

  test('a leap day in a leap year is a day', () => {
    expect(sitemapDatetime('2024-02-29', NOW)).toBe('2024-02-29T00:00:00.000Z');
  });

  test('a clock time without a zone is still refused', () => {
    expect(sitemapDatetime('2026-10-01T10:00:00', NOW)).toBeUndefined();
  });

  test('an impossible clock time is refused, not wrapped', () => {
    expect(sitemapDatetime('2026-10-01T25:00Z', NOW)).toBeUndefined();
  });
});
