// Every code render declares must carry a title, be registered after import, and document at
// the standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { RENDER_ERROR_CODES, RENDER_ERROR_TITLES } from './errors';

describe('render error titles', () => {
  test('every code in RENDER_ERROR_CODES has a title, and every title maps to a declared code', () => {
    expect(Object.keys(RENDER_ERROR_TITLES).sort()).toEqual([...RENDER_ERROR_CODES].sort());
  });

  test('every code is registered with its declared title after import', () => {
    for (const code of RENDER_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(RENDER_ERROR_TITLES[code]);
    }
  });

  test('every code documents at the standard docs URL', () => {
    for (const code of RENDER_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
