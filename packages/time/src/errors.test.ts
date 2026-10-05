// Every code time declares must carry a title, be registered after import, and document at the
// standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { scheduleInvalid, TIME_ERROR_CODES, TIME_ERROR_TITLES } from './errors';

describe('time error titles', () => {
  test('every code in TIME_ERROR_CODES has a title, and every title maps to a declared code', () => {
    expect(Object.keys(TIME_ERROR_TITLES).sort()).toEqual([...TIME_ERROR_CODES].sort());
  });

  test('every code is registered with its declared title after import', () => {
    for (const code of TIME_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(TIME_ERROR_TITLES[code]);
    }
  });

  test('every code documents at the standard docs URL', () => {
    for (const code of TIME_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });
});

// `scheduleInvalid` takes the rejected wall-clock field as `unknown` and is exported, so the value
// it renders is whatever a caller passed — a `LocalSlot` built from a form field, a JSON payload or
// a config file. Rendering it with `String()` runs the value's own `toString`, so the refusal died
// and the caller caught the value's throw instead: `X_SCHEDULE_INVALID` never existed.
describe('scheduleInvalid renders a value it does not control', () => {
  const hostile = (): ReadonlyMap<string, unknown> => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    return new Map<string, unknown>([
      [
        'a hostile toString',
        {
          toString: () => {
            throw new Error('gotcha');
          },
        },
      ],
      ['a symbol', Symbol('hour')],
      ['a bigint', 9n],
      ['a cycle', cyclic],
      ['a null-prototype object', Object.assign(Object.create(null), { hour: 25 })],
    ]);
  };

  for (const [label, value] of hostile()) {
    test(`refuses with X_SCHEDULE_INVALID for ${label}`, () => {
      let error: unknown;
      expect(() => {
        error = scheduleInvalid('slot.hour', value, 'an integer 0-23');
      }).not.toThrow();
      expect((error as { code: string }).code).toBe('X_SCHEDULE_INVALID');
      expect((error as { cause: string }).cause).toContain('slot.hour must be an integer 0-23');
    });
  }

  test('an in-range-looking number still reads exactly as it did', () => {
    expect(scheduleInvalid('slot.hour', 25, 'an integer 0-23').cause).toBe(
      'slot.hour must be an integer 0-23, got 25',
    );
  });
});

// A calendar is not a wall-clock field, and the field fix ("pass an integer in … for calendar")
// read as nonsense for it. Two ways a calendar has no business day, and each repair is different:
// a weekend that covers the week needs a shorter weekend; a holiday list that covers the rest
// needs fewer holidays. Each fix is a call that runs as written — no free identifiers, no comment.
describe('scheduleInvalid gives each calendar refusal its own runnable fix', () => {
  const weekend = scheduleInvalid(
    'calendar.weekendDays',
    [1, 2, 3, 4, 5, 6, 7],
    'ISO weekdays (1-7) that leave at least one business day',
  );
  const holidays = scheduleInvalid(
    'calendar.holidays',
    3650,
    'dates that leave at least one business day in any ten-year window',
  );
  const transpiler = new Bun.Transpiler({ loader: 'ts' });

  test('a weekend covering the week is repaired by a weekend that does not', () => {
    expect(weekend.fix).toBe(
      "addBusinessDays(new Date(), 1, { zone: 'UTC', weekendDays: [6, 7] })",
    );
  });

  test('a holiday list covering every business day is repaired by fewer holidays', () => {
    expect(holidays.fix).toBe("addBusinessDays(new Date(), 1, { zone: 'UTC', holidays: [] })");
    expect(holidays.fix).not.toBe(weekend.fix);
  });

  test.each([
    ['weekend', weekend],
    ['holidays', holidays],
  ])('the %s fix parses as TypeScript, as written', (_name, error) => {
    expect(() => transpiler.transformSync(error.fix)).not.toThrow();
    expect(error.fix).not.toContain('#');
  });

  test('the explanation is in the cause, with the code every other field gets', () => {
    expect(weekend.code).toBe('X_SCHEDULE_INVALID');
    expect(weekend.cause).toBe(
      'calendar.weekendDays must be ISO weekdays (1-7) that leave at least one business day, got [1,2,3,4,5,6,7]',
    );
    expect(holidays.cause).toContain('calendar.holidays must be');
  });

  test('a wall-clock field keeps its own fix', () => {
    expect(scheduleInvalid('slot.hour', 25, 'an integer 0-23').fix).toStartWith(
      'pass an integer in an integer 0-23 for slot.hour',
    );
  });
});
