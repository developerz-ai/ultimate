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
