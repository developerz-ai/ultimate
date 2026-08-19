import { describe, expect, test } from 'bun:test';
import { formatDate, formatIsoDate, formatRelative, formatWithOffset, ordinal } from './format';
import { fromIso } from './instant';
import { isoDateInZone } from './zoned';

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

  // T7. It took a `locale`, selected the plural CATEGORY with it, and then appended the English
  // suffix for that category regardless — `ordinal(1, 'de')` was `'1th'`, which is a word in no
  // language. A parameter that cannot change the answer correctly is removed, so a caller who
  // wanted a localized ordinal finds out at BUILD time rather than in a rendered page.
  test('takes no locale at all, so it can never append a suffix no language uses', () => {
    // A locale used to reach `Intl.PluralRules` and pick the CATEGORY, while the suffix table
    // stayed English: `ordinal(1, 'de')` was `'1th'`. Passing one is now a compile error, and the
    // cast below is the runtime half of the same statement — the second argument cannot change
    // the answer at all, so nothing can select the German category any more.
    const loose = ordinal as unknown as (value: number, locale?: string) => string;
    expect(loose(1, 'de')).toBe('1st');
    expect(loose(3, 'de')).toBe('3rd');
    expect(loose(1, 'fr')).toBe('1st');
  });
});

describe('formatIsoDate', () => {
  test('the parts are ISO, in the zone, for the day the zone is on', () => {
    // Midnight UTC on the 14th is still the 13th in New York.
    expect(formatIsoDate(fromIso('2026-03-14T00:30:00Z'), 'UTC')).toBe('2026-03-14');
    expect(formatIsoDate(fromIso('2026-03-14T00:30:00Z'), 'America/New_York')).toBe('2026-03-13');
    expect(formatIsoDate(fromIso('2026-03-14T00:30:00Z'), 'Asia/Tokyo')).toBe('2026-03-14');
  });

  // T3. `year: 'numeric'` neither zero-pads a year below 1000 nor carries an era, so this
  // answered `'50-01-01'` where `isoDateInZone` — the other function in this package that answers
  // the same question — answered `'0050-01-01'`. `'50-01-01'` matches no ISO pattern and is
  // rejected by `<input type="date">`, which is one of the two callers named in the doc.
  test('pads a year below 1000, and agrees with isoDateInZone', () => {
    const early = fromIso('0050-01-01T12:00:00Z');
    expect(formatIsoDate(early, 'UTC')).toBe('0050-01-01');
    expect(formatIsoDate(early, 'UTC')).toBe(isoDateInZone(early, 'UTC'));
    expect(formatIsoDate(early, 'UTC')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('the two functions agree across zones and eras — one question, one answer', () => {
    const zones = ['UTC', 'Europe/Berlin', 'America/New_York', 'Asia/Kathmandu', 'Pacific/Apia'];
    const instants = [
      '0050-01-01T12:00:00Z',
      '0999-12-31T23:30:00Z',
      '1000-01-01T00:30:00Z',
      '2026-03-14T00:30:00Z',
      '2026-11-01T05:30:00Z',
    ];
    for (const iso of instants) {
      for (const zone of zones) {
        expect(formatIsoDate(fromIso(iso), zone)).toBe(isoDateInZone(fromIso(iso), zone));
      }
    }
  });
});
