import { describe, expect, test } from 'bun:test';
import { formatDate, formatIsoDate, formatRelative, formatWithOffset, ordinal } from './format';
import { fromIso } from './instant';

const at = fromIso('2026-03-14T08:00:00Z');

describe('formatWithOffset', () => {
  test('renders the same instant in two zones with its offset', () => {
    expect(formatWithOffset(at, { locale: 'en-GB', zone: 'Europe/Berlin' })).toBe(
      '14 Mar 2026, 09:00 (GMT+1)',
    );
    expect(formatWithOffset(at, { locale: 'en-GB', zone: 'America/New_York' })).toBe(
      '14 Mar 2026, 04:00 (GMT-4)',
    );
  });

  test('surfaces a 45-minute offset instead of rounding it away', () => {
    const rendered = formatWithOffset(at, { locale: 'en-GB', zone: 'Asia/Kathmandu' });
    expect(rendered).toContain('13:45');
    expect(rendered).toContain('GMT+5:45');
  });
});

describe('formatDate', () => {
  test('locale decides the order, zone decides the day', () => {
    expect(formatDate(at, { locale: 'de-DE', zone: 'Europe/Berlin', style: 'long' })).toBe(
      '14. März 2026',
    );
    // 08:00Z is still 13 March in Los Angeles — the zone changes the calendar day.
    expect(formatIsoDate(at, 'America/Los_Angeles')).toBe('2026-03-14');
    expect(formatIsoDate(fromIso('2026-03-14T04:00:00Z'), 'America/Los_Angeles')).toBe(
      '2026-03-13',
    );
  });
});

describe('formatRelative', () => {
  test('picks the largest unit that fits, relative to an injected now', () => {
    const now = fromIso('2026-03-14T08:00:00Z');
    expect(formatRelative(fromIso('2026-03-17T08:00:00Z'), { locale: 'en', now })).toBe(
      'in 3 days',
    );
    expect(formatRelative(fromIso('2026-03-14T06:00:00Z'), { locale: 'en', now })).toBe(
      '2 hours ago',
    );
    expect(formatRelative(fromIso('2026-03-14T08:00:00Z'), { locale: 'en', now })).toBe('now');
  });
});

describe('ordinal', () => {
  test('English ordinals via Intl.PluralRules, not a suffix table', () => {
    expect(ordinal(1)).toBe('1st');
    expect(ordinal(2)).toBe('2nd');
    expect(ordinal(3)).toBe('3rd');
    expect(ordinal(4)).toBe('4th');
    expect(ordinal(11)).toBe('11th');
    expect(ordinal(22)).toBe('22nd');
    expect(ordinal(101)).toBe('101st');
  });
});
