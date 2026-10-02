// A calendar date has no time and no zone, and this file is what says so: the cases that must be
// refused (a day the month does not have), and the two conversions to an instant — one that asks
// for a zone because it cannot answer without one, and one that names UTC in its own name.

import { describe, expect, test } from 'bun:test';
import { isIsoDateTime } from '@ultimat3/schema';
import { fromIso } from './instant';
import {
  addPlainDays,
  comparePlainDates,
  isPlainDate,
  PLAIN_DATE_PATTERN,
  type PlainDate,
  plainDate,
  plainDateIn,
  plainDateOf,
  plainDateParts,
  plainDateToUtcInstant,
  plainDateUtc,
  plainDaysBetween,
} from './plain-date';

describe('unit · plainDate', () => {
  test('takes an ISO calendar date and refuses everything that only looks like one', () => {
    expect(plainDate('2026-03-14')).toBe('2026-03-14' as PlainDate);
    for (const bad of [
      '2026-02-30',
      '2025-02-29',
      '2026-13-01',
      '2026-00-10',
      '2026-03-00',
      '2026-3-14',
      '2026-03-14T00:00:00Z',
      '14/03/2026',
      '',
      'nope',
    ]) {
      expect(() => plainDate(bad)).toThrow();
      expect(isPlainDate(bad)).toBe(false);
    }
  });

  test('a leap day exists in a leap year and not otherwise — the rule a regex cannot hold', () => {
    expect(isPlainDate('2024-02-29')).toBe(true);
    expect(isPlainDate('2000-02-29')).toBe(true);
    expect(isPlainDate('1900-02-29')).toBe(false);
    expect(isPlainDate('2026-02-29')).toBe(false);
  });

  test('the exported pattern accepts exactly the shape the parser does', () => {
    const pattern = new RegExp(PLAIN_DATE_PATTERN);
    expect(pattern.test('2026-03-14')).toBe(true);
    expect(pattern.test('2026-3-14')).toBe(false);
  });

  test('fields in, date out — an impossible day throws instead of rolling into next month', () => {
    expect(plainDateOf({ year: 2026, month: 3, day: 4 })).toBe('2026-03-04' as PlainDate);
    expect(plainDateOf({ year: 926, month: 12, day: 31 })).toBe('0926-12-31' as PlainDate);
    expect(() => plainDateOf({ year: 2026, month: 2, day: 30 })).toThrow();
    expect(plainDateParts('2026-03-14' as PlainDate)).toEqual({ year: 2026, month: 3, day: 14 });
  });
});

describe('unit · plainDate and instants', () => {
  test('an instant has a date only IN a zone, and the answer differs by zone', () => {
    const at = fromIso('2026-03-14T02:30:00.000Z');
    expect(plainDateIn(at, 'UTC')).toBe('2026-03-14' as PlainDate);
    expect(plainDateIn(at, 'America/Los_Angeles')).toBe('2026-03-13' as PlainDate);
    expect(plainDateIn(at, 'Asia/Tokyo')).toBe('2026-03-14' as PlainDate);
  });

  test('a driver Date at UTC midnight reads back as the date it holds, in any local zone', () => {
    // The measured case: Postgres hands a `date` column back as midnight UTC. Reading its LOCAL
    // components loses a day west of Greenwich, which is the bug this function exists to not have.
    const fromDriver = new Date('2026-03-14T00:00:00.000Z');
    expect(plainDateUtc(fromDriver)).toBe('2026-03-14' as PlainDate);
    expect(plainDateToUtcInstant('2026-03-14' as PlainDate).toISOString()).toBe(
      '2026-03-14T00:00:00.000Z',
    );
  });

  test('the UTC read holds in a zone that is not UTC — which bun test alone cannot show', () => {
    // `bun test` pins the process to UTC, so every assertion above passes whether this function
    // reads UTC components or local ones. The zone has to come from OUTSIDE the runner, which is
    // what makes this a subprocess: in America/Los_Angeles, midnight UTC on the 14th is the 13th
    // locally, and a `date` column read through local components loses a day for half the planet.
    const source = [
      `import { plainDateUtc } from '${import.meta.dir}/plain-date';`,
      "const at = new Date('2026-03-14T00:00:00.000Z');",
      'console.log(JSON.stringify({',
      '  zone: Intl.DateTimeFormat().resolvedOptions().timeZone,',
      '  local: at.getDate(),',
      '  answer: plainDateUtc(at),',
      '}));',
    ].join('\n');
    const run = Bun.spawnSync(['bun', '-e', source], {
      env: { ...process.env, TZ: 'America/Los_Angeles' },
    });
    const out = new TextDecoder().decode(run.stdout).trim();
    const seen = JSON.parse(out) as { zone: string; local: number; answer: string };
    // The control: the subprocess really is west of Greenwich, so a local read WOULD answer the 13th.
    expect(seen.zone).toBe('America/Los_Angeles');
    expect(seen.local).toBe(13);
    expect(seen.answer).toBe('2026-03-14');
  });

  test('a date carries no time: the round trip through an instant adds none', () => {
    const date = plainDateUtc(plainDateToUtcInstant('2026-07-01' as PlainDate));
    expect(date).toBe('2026-07-01' as PlainDate);
    expect(String(date)).not.toContain('T');
    expect(String(date)).not.toContain(':');
  });
});

describe('unit · plainDate arithmetic', () => {
  test('adding days crosses months, years and a leap day without a zone in sight', () => {
    expect(addPlainDays('2026-02-28' as PlainDate, 1)).toBe('2026-03-01' as PlainDate);
    expect(addPlainDays('2024-02-28' as PlainDate, 1)).toBe('2024-02-29' as PlainDate);
    expect(addPlainDays('2026-12-31' as PlainDate, 1)).toBe('2027-01-01' as PlainDate);
    expect(addPlainDays('2026-01-01' as PlainDate, -1)).toBe('2025-12-31' as PlainDate);
    expect(() => addPlainDays('2026-01-01' as PlainDate, 1.5)).toThrow();
  });

  test('a DST day is still one day, because there is no zone to shorten it', () => {
    // 2026-03-08 is a US spring-forward day: 23 real hours in America/New_York, one calendar day.
    expect(addPlainDays('2026-03-08' as PlainDate, 1)).toBe('2026-03-09' as PlainDate);
    expect(plainDaysBetween('2026-03-08' as PlainDate, '2026-03-09' as PlainDate)).toBe(1);
    expect(plainDaysBetween('2026-03-09' as PlainDate, '2026-03-08' as PlainDate)).toBe(-1);
    expect(plainDaysBetween('2026-01-01' as PlainDate, '2027-01-01' as PlainDate)).toBe(365);
  });

  test('lexicographic order is chronological order, which is why a date sorts as a string', () => {
    const dates = ['2026-12-01', '2026-02-28', '2025-12-31'] as PlainDate[];
    expect([...dates].sort()).toEqual(['2025-12-31', '2026-02-28', '2026-12-01'] as PlainDate[]);
    expect(comparePlainDates('2026-02-28' as PlainDate, '2026-12-01' as PlainDate)).toBe(-1);
    expect(comparePlainDates('2026-02-28' as PlainDate, '2026-02-28' as PlainDate)).toBe(0);
    expect(comparePlainDates('2027-01-01' as PlainDate, '2026-12-31' as PlainDate)).toBe(1);
  });
});

/**
 * The calendar rule, as a table. **Twin: `packages/schema/src/iso-date.test.ts` holds the same rows
 * against `isIsoDateTime`** — schema is tier 0 and cannot import `time`, so `daysInMonth` is
 * restated there. `time` may import schema, so this copy also asks both predicates the same
 * question directly: a row added on one side only still fails here.
 */
const CALENDAR_PARITY: readonly (readonly [string, boolean])[] = [
  ['2026-01-31', true],
  ['2026-01-32', false],
  ['2026-02-28', true],
  ['2026-02-29', false],
  ['2026-02-30', false],
  ['2024-02-29', true],
  ['2024-02-30', false],
  ['2000-02-29', true],
  ['1900-02-29', false],
  ['2026-03-31', true],
  ['2026-04-30', true],
  ['2026-04-31', false],
  ['2026-05-31', true],
  ['2026-06-30', true],
  ['2026-06-31', false],
  ['2026-07-31', true],
  ['2026-08-31', true],
  ['2026-09-30', true],
  ['2026-09-31', false],
  ['2026-10-31', true],
  ['2026-11-30', true],
  ['2026-11-31', false],
  ['2026-12-31', true],
  ['2026-12-32', false],
  ['2026-00-10', false],
  ['2026-13-01', false],
  ['2026-03-00', false],
];

describe('unit · plainDate and t.date agree on which days exist', () => {
  test.each(CALENDAR_PARITY)('%p -> %p', (value, real) => {
    expect(isPlainDate(value)).toBe(real);
    expect(isIsoDateTime(value)).toBe(real);
  });

  test('every day of a leap year and a common year, asked of both', () => {
    for (const year of [2024, 2026, 1900, 2000]) {
      for (let month = 1; month <= 12; month += 1) {
        for (let day = 0; day <= 32; day += 1) {
          const value = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
          expect([value, isIsoDateTime(value)]).toEqual([value, isPlainDate(value)]);
        }
      }
    }
  });
});

describe('unit · plainDate stays inside the four-digit years it can spell', () => {
  const refused = (run: () => unknown): unknown => {
    try {
      run();
    } catch (error) {
      return error;
    }
    return undefined;
  };

  test('addPlainDays past 9999-12-31 is refused, never a five-digit year branded PlainDate', () => {
    expect(refused(() => addPlainDays(plainDate('9999-12-31'), 1))).toMatchObject({
      code: 'X_SCHEDULE_INVALID',
    });
    expect(refused(() => addPlainDays(plainDate('0000-01-01'), -1))).toMatchObject({
      code: 'X_SCHEDULE_INVALID',
    });
    expect(addPlainDays(plainDate('9999-12-30'), 1)).toBe(plainDate('9999-12-31'));
    expect(addPlainDays(plainDate('0000-01-02'), -1)).toBe(plainDate('0000-01-01'));
  });

  test('plainDateUtc refuses a Date outside them, so what it returns is always a PlainDate', () => {
    expect(refused(() => plainDateUtc(new Date(Date.UTC(10000, 0, 1))))).toMatchObject({
      code: 'X_SCHEDULE_INVALID',
    });
    expect(refused(() => plainDateUtc(new Date(Date.UTC(-1, 11, 31))))).toMatchObject({
      code: 'X_SCHEDULE_INVALID',
    });
    expect(isPlainDate(plainDateUtc(new Date(Date.UTC(9999, 11, 31))))).toBe(true);
  });

  test('plainDateIn refuses an instant whose local date is outside them', () => {
    // 9999-12-31T23:30Z is still 9999 in UTC and already year 10000 in Tokyo.
    const edge = fromIso('9999-12-31T23:30:00Z');
    expect(plainDateIn(edge, 'UTC')).toBe(plainDate('9999-12-31'));
    expect(refused(() => plainDateIn(edge, 'Asia/Tokyo'))).toMatchObject({
      code: 'X_SCHEDULE_INVALID',
    });
    expect(isPlainDate(plainDateIn(fromIso('2026-03-14T09:00:00Z'), 'America/Los_Angeles'))).toBe(
      true,
    );
  });
});
