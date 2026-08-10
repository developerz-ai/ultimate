// Every code time declares must carry a title, be registered after import, and document at the
// standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { TIME_ERROR_CODES, TIME_ERROR_TITLES } from './errors';

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
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
