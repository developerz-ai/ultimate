// Every public function that takes a zone refuses a value that is not a zone STRING with
// `X_TIMEZONE_INVALID` — never the bare `TypeError` an untyped caller (plain JS, a JSON-driven
// call, an `as never`) used to get out of `zone.toLowerCase()` several frames down.

import { describe, expect, test } from 'bun:test';
import {
  addBusinessDays,
  addDaysInZone,
  assertTimeZone,
  businessDaysBetween,
  canonicalTimeZone,
  configureTime,
  daysBetween,
  endOfDay,
  firedSince,
  formatDate,
  formatDateTime,
  formatIsoDate,
  formatRange,
  formatRelative,
  formatTime,
  formatWithOffset,
  fromIso,
  fromZoned,
  fromZonedDetailed,
  isBusinessDay,
  isHoliday,
  isoDateInZone,
  isoInZone,
  isSameLocalDay,
  isValidTimeZone,
  isWeekend,
  matchesCron,
  nextBusinessDay,
  nextCronOccurrence,
  nextCronOccurrenceMs,
  nextCronOccurrences,
  nextLocalSlot,
  nextLocalSlots,
  nextWeeklySlot,
  observesDst,
  offsetAt,
  plainDateIn,
  startOfDay,
  timeConfig,
  toZoned,
  zoneAbbrev,
  zonePartsAt,
} from './index';

const at = fromIso('2026-03-14T08:00:00Z');
const wall = { year: 2026, month: 3, day: 14, hour: 9, minute: 0 };

/** Each entry calls one public function with `zone` in the position a zone goes. */
const TAKES_A_ZONE: readonly (readonly [string, (zone: never) => unknown])[] = [
  ['assertTimeZone', (zone) => assertTimeZone(zone)],
  ['toZoned', (zone) => toZoned(at, zone)],
  ['fromZoned', (zone) => fromZoned(wall, zone)],
  ['fromZonedDetailed', (zone) => fromZonedDetailed(wall, zone)],
  ['startOfDay', (zone) => startOfDay(at, zone)],
  ['endOfDay', (zone) => endOfDay(at, zone)],
  ['addDaysInZone', (zone) => addDaysInZone(at, 1, zone)],
  ['isoDateInZone', (zone) => isoDateInZone(at, zone)],
  ['isoInZone', (zone) => isoInZone(at, zone)],
  ['isSameLocalDay', (zone) => isSameLocalDay(at, at, zone)],
  ['daysBetween', (zone) => daysBetween(at, at, zone)],
  ['plainDateIn', (zone) => plainDateIn(at, zone)],
  ['zonePartsAt', (zone) => zonePartsAt(zone, at)],
  ['offsetAt', (zone) => offsetAt(zone, at)],
  ['observesDst', (zone) => observesDst(zone, at)],
  ['zoneAbbrev', (zone) => zoneAbbrev(zone, at)],
  ['matchesCron', (zone) => matchesCron('0 3 * * *', at, zone)],
  ['nextCronOccurrence', (zone) => nextCronOccurrence('0 3 * * *', zone, at)],
  ['nextCronOccurrences', (zone) => nextCronOccurrences('0 3 * * *', zone, at, 2)],
  ['nextCronOccurrenceMs', (zone) => nextCronOccurrenceMs('0 3 * * *', zone, at.getTime())],
  ['firedSince', (zone) => firedSince('0 3 * * *', zone, at, fromIso('2026-03-15T08:00:00Z'))],
  ['nextLocalSlot', (zone) => nextLocalSlot({ zone, hour: 9 }, at)],
  ['nextLocalSlots', (zone) => nextLocalSlots({ zone, hour: 9 }, at, 2)],
  ['nextWeeklySlot', (zone) => nextWeeklySlot({ zone, hour: 9, weekday: 1 }, at)],
  ['isWeekend', (zone) => isWeekend(at, zone)],
  ['isHoliday', (zone) => isHoliday(at, { zone, holidays: ['2026-03-14'] })],
  ['isBusinessDay', (zone) => isBusinessDay(at, { zone })],
  ['addBusinessDays', (zone) => addBusinessDays(at, 1, { zone })],
  ['nextBusinessDay', (zone) => nextBusinessDay(at, { zone })],
  [
    'businessDaysBetween',
    (zone) => businessDaysBetween(at, fromIso('2026-03-20T08:00:00Z'), { zone }),
  ],
  ['formatDateTime', (zone) => formatDateTime(at, { locale: 'en', zone })],
  ['formatDate', (zone) => formatDate(at, { locale: 'en', zone })],
  ['formatTime', (zone) => formatTime(at, { locale: 'en', zone })],
  ['formatWithOffset', (zone) => formatWithOffset(at, { locale: 'en', zone })],
  ['formatRange', (zone) => formatRange(at, at, { locale: 'en', zone })],
  ['formatRelative', (zone) => formatRelative(at, { locale: 'en', zone, now: at })],
  ['formatIsoDate', (zone) => formatIsoDate(at, zone)],
];

const NOT_A_ZONE: readonly (readonly [string, unknown])[] = [
  ['undefined', undefined],
  ['null', null],
  ['a number', 42],
  ['an object', { zone: 'UTC' }],
];

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('a zone that is not a string', () => {
  const before = timeConfig().defaultZone;
  for (const [name, call] of TAKES_A_ZONE) {
    for (const [label, value] of NOT_A_ZONE) {
      test(`${name} refuses ${label} with X_TIMEZONE_INVALID`, () => {
        expect(caught(() => call(value as never))).toMatchObject({ code: 'X_TIMEZONE_INVALID' });
        expect(timeConfig().defaultZone).toBe(before);
      });
    }
  }

  for (const [label, value] of NOT_A_ZONE.slice(1)) {
    test(`configureTime refuses ${label} as defaultZone and keeps the zone in force`, () => {
      expect(caught(() => configureTime({ defaultZone: value as never }))).toMatchObject({
        code: 'X_TIMEZONE_INVALID',
      });
      expect(timeConfig().defaultZone).toBe(before);
    });
  }

  test('configureTime reads an undefined defaultZone as "not given", never as the new zone', () => {
    configureTime({ defaultZone: undefined as never });
    expect(timeConfig().defaultZone).toBe(before);
  });

  test('the two predicates answer instead of throwing', () => {
    for (const [, value] of NOT_A_ZONE) {
      expect(canonicalTimeZone(value as never)).toBeUndefined();
      expect(isValidTimeZone(value as never)).toBe(false);
    }
  });

  test('the cause says what arrived, without interpolating it raw', () => {
    const error = caught(() => assertTimeZone(undefined as never)) as { message: string };
    expect(error.message).toContain('undefined is not an IANA');
    expect((caught(() => assertTimeZone('CET')) as { message: string }).message).toContain(
      '"CET" is not an IANA',
    );
  });
});

describe('a formatter called with no options object at all', () => {
  const NO_OPTIONS: readonly (readonly [string, () => unknown])[] = [
    ['formatDateTime', () => formatDateTime(at, undefined as never)],
    ['formatDate', () => formatDate(at, undefined as never)],
    ['formatTime', () => formatTime(at, undefined as never)],
    ['formatWithOffset', () => formatWithOffset(at, undefined as never)],
    ['formatRange', () => formatRange(at, at, undefined as never)],
    ['formatRelative', () => formatRelative(at, undefined as never)],
    ['formatRelative(null)', () => formatRelative(at, null as never)],
  ];
  for (const [name, run] of NO_OPTIONS) {
    test(`${name} is X_TIMEZONE_INVALID, never a bare TypeError`, () => {
      expect(caught(run)).toMatchObject({ code: 'X_TIMEZONE_INVALID' });
    });
  }
});
