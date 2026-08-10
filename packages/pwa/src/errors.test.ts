// The titles registered here are the first line of every pwa error a build sees — in the
// terminal, the dev overlay and `--json`. This proves the registry actually reflects what
// PWA_ERROR_TITLES declares, including the one code (`X_NOT_IMPLEMENTED`) this package borrows
// rather than owns.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { PWA_ERROR_CODES, PWA_ERROR_TITLES } from './errors';

describe('PWA_ERROR_TITLES', () => {
  test('has exactly one entry per code in PWA_ERROR_CODES, and no others', () => {
    expect(Object.keys(PWA_ERROR_TITLES).sort()).toEqual([...PWA_ERROR_CODES].sort());
  });

  test('every title is a non-empty string', () => {
    for (const code of PWA_ERROR_CODES) {
      expect(typeof PWA_ERROR_TITLES[code]).toBe('string');
      expect(PWA_ERROR_TITLES[code].length).toBeGreaterThan(0);
    }
  });
});

describe('error code registry', () => {
  test('every pwa code is registered with its declared title', () => {
    for (const code of PWA_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(PWA_ERROR_TITLES[code]);
    }
  });

  test('every pwa code documents at its own X_* url', () => {
    for (const code of PWA_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered with a pwa-owned title', () => {
    expect(hasErrorCode('X_NOT_IMPLEMENTED')).toBe(true);
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
    expect(PWA_ERROR_TITLES.X_NOT_IMPLEMENTED).toBe(describeErrorCode('X_NOT_IMPLEMENTED').title);
  });
});
