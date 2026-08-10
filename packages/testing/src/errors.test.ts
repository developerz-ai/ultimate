// A test failure has to be as actionable as a runtime failure, and the title is the first line
// of that contract — in the terminal, the dev overlay and `--json`. These tests prove the
// registry actually reflects what TESTING_ERROR_TITLES declares.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { TESTING_ERROR_CODES, TESTING_ERROR_TITLES } from './errors';

describe('TESTING_ERROR_TITLES', () => {
  test('has exactly one entry per code in TESTING_ERROR_CODES, and no others', () => {
    expect(Object.keys(TESTING_ERROR_TITLES).sort()).toEqual([...TESTING_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(typeof TESTING_ERROR_TITLES[code]).toBe('string');
      expect(TESTING_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every testing code is registered with its declared title', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(TESTING_ERROR_TITLES[code]);
    }
  });

  test('every testing code documents at its own X_* url', () => {
    for (const code of TESTING_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
