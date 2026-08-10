// The titles registered here render as the first line of every money error a caller sees — in
// the terminal, `--json`, and `x errors explain`. A code with no title, or a title the registry
// disagrees with, is a broken contract nothing else here would catch.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { MONEY_ERROR_CODES, MONEY_ERROR_TITLES } from './errors';

describe('MONEY_ERROR_TITLES', () => {
  test('has exactly one entry per code in MONEY_ERROR_CODES, and no others', () => {
    expect(Object.keys(MONEY_ERROR_TITLES).sort()).toEqual([...MONEY_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(typeof MONEY_ERROR_TITLES[code]).toBe('string');
      expect(MONEY_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every money code is registered with its declared title', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(MONEY_ERROR_TITLES[code]);
    }
  });

  test('every money code documents at its own X_* url', () => {
    for (const code of MONEY_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
