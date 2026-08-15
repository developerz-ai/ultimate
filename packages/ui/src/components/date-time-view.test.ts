import { describe, expect, test } from 'bun:test';
import type { TimeZone } from '@ultimat3/time';
import { UI_ERROR_CODES } from '../errors';
import { type DateTimeFormatter, dateTimeView, toDate, toIsoInstant } from './date-time-view';

const seen: Array<{ locale: string; zone: string; iso: string }> = [];
const format: DateTimeFormatter = (at, options) => {
  seen.push({ locale: options.locale, zone: options.zone, iso: at.toISOString() });
  return `${options.locale}@${options.zone}`;
};

const INSTANT = '2026-07-26T21:30:00.000Z';

describe('dateTimeView', () => {
  test('carries the ISO instant for the <time datetime> attribute', () => {
    const view = dateTimeView({
      value: INSTANT,
      locale: 'en-NZ',
      timeZone: 'Pacific/Auckland' as TimeZone,
      format,
    });
    expect(view.dateTime).toBe(INSTANT);
  });

  test('formats through the injected tz and locale, never an ambient default', () => {
    seen.length = 0;
    dateTimeView({ value: INSTANT, locale: 'de-DE', timeZone: 'Europe/Berlin', format });
    dateTimeView({ value: INSTANT, locale: 'en-NZ', timeZone: 'Pacific/Auckland', format });
    expect(seen).toEqual([
      { locale: 'de-DE', zone: 'Europe/Berlin', iso: INSTANT },
      { locale: 'en-NZ', zone: 'Pacific/Auckland', iso: INSTANT },
    ]);
  });

  test('the ISO instant is UTC regardless of the display zone', () => {
    const utc = dateTimeView({ value: INSTANT, locale: 'en', timeZone: 'UTC', format });
    const auckland = dateTimeView({
      value: INSTANT,
      locale: 'en',
      timeZone: 'Pacific/Auckland',
      format,
    });
    expect(utc.dateTime).toBe(auckland.dateTime);
    expect(utc.text).not.toBe(auckland.text);
  });

  test('the same instant renders a different wall clock per zone via @ultimat3/time', () => {
    const berlin = dateTimeView({ value: INSTANT, locale: 'en-GB', timeZone: 'Europe/Berlin' });
    const auckland = dateTimeView({
      value: INSTANT,
      locale: 'en-GB',
      timeZone: 'Pacific/Auckland',
    });
    expect(berlin.dateTime).toBe(auckland.dateTime);
    expect(berlin.text).not.toBe(auckland.text);
  });

  test('accepts Date, ISO string, and epoch millis identically', () => {
    const millis = Date.parse(INSTANT);
    expect(toIsoInstant(new Date(millis))).toBe(INSTANT);
    expect(toIsoInstant(INSTANT)).toBe(INSTANT);
    expect(toIsoInstant(millis)).toBe(INSTANT);
  });

  test('an unparseable value throws X_UI_INVALID_VALUE with a fix', () => {
    try {
      toIsoInstant('not-a-date');
      throw new Error('expected a throw');
    } catch (error) {
      const err = error as { code?: string; fix?: string };
      expect(err.code).toBe(UI_ERROR_CODES.invalidValue);
      expect(err.fix).toContain('loader');
    }
  });
});

describe('unit · the parse is zoned too, not just the format', () => {
  // `new Date('2026-08-14T09:00')` resolves in the HOST's zone, so the same props rendered
  // `Aug 14, 09:00` on a TZ=UTC runner and `Aug 14, 00:00` on TZ=Asia/Tokyo — an ambient default
  // inside the one package that forbids them, and no error either way.
  test('an offset-less datetime string is refused, whatever the host zone is', () => {
    for (const value of ['2026-08-14T09:00', '2026-08-14T09:00:00', '2026-08-14 09:00']) {
      expect(() => toDate(value)).toThrow();
      const error = (() => {
        try {
          toDate(value);
        } catch (caught) {
          return caught as { code?: string; fix?: string };
        }
        return {};
      })();
      expect(error.code).toBe('X_UI_INVALID_VALUE');
    }
  });

  test('Z, an offset, a date-only string, a Date and epoch millis all still parse', () => {
    expect(toDate('2026-08-14T09:00:00.000Z').toISOString()).toBe('2026-08-14T09:00:00.000Z');
    expect(toDate('2026-08-14T09:00+02:00').toISOString()).toBe('2026-08-14T07:00:00.000Z');
    // Date-only is zone-independent by spec: the parse is UTC, so nothing ambient decides it.
    expect(toDate('2026-08-14').toISOString()).toBe('2026-08-14T00:00:00.000Z');
    expect(toDate(new Date(0)).toISOString()).toBe('1970-01-01T00:00:00.000Z');
    expect(toDate(0).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});
