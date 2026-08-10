// Every code jobs declares must carry a title, be registered after import, and document at the
// standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { JOB_ERROR_CODES, JOB_ERROR_TITLES } from './errors';

describe('job error titles', () => {
  test('every code in JOB_ERROR_CODES has a title, and every title maps to a declared code', () => {
    expect(Object.keys(JOB_ERROR_TITLES).sort()).toEqual([...JOB_ERROR_CODES].sort());
  });

  test('every code is registered with its declared title after import', () => {
    for (const code of JOB_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(JOB_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not redefined', () => {
    // jobs never registers this code (hasErrorCode() short-circuits the loop in errors.ts), so
    // this only holds if jobs' own copy of the text still matches core's registered title.
    const coreTitle = 'this driver does not implement the requested feature';
    expect(JOB_ERROR_TITLES.X_NOT_IMPLEMENTED).toBe(coreTitle);
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(coreTitle);
  });

  test('every code documents at the standard docs URL', () => {
    for (const code of JOB_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
