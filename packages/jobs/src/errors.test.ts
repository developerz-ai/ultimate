// Every code jobs declares must carry a title, be registered after import, and document at the
// standard URL — the same contract `x errors explain <CODE>` relies on for every package.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  JOB_BORROWED_ERROR_CODES,
  JOB_ERROR_CODES,
  JOB_ERROR_TITLES,
  JOB_OWNED_ERROR_CODES,
} from './errors';

describe('job error titles', () => {
  test('titles exactly the codes jobs owns — a borrowed code carries no title here', () => {
    expect(Object.keys(JOB_ERROR_TITLES).sort()).toEqual([...JOB_OWNED_ERROR_CODES].sort());
  });

  test('owned and borrowed are disjoint and together are every code jobs throws', () => {
    const owned = new Set<string>(JOB_OWNED_ERROR_CODES);
    for (const code of JOB_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...JOB_ERROR_CODES].sort()).toEqual(
      [...JOB_OWNED_ERROR_CODES, ...JOB_BORROWED_ERROR_CODES].sort(),
    );
  });

  test('every owned code is registered with its declared title after import', () => {
    for (const code of JOB_OWNED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(JOB_ERROR_TITLES[code]);
    }
  });

  test('every borrowed code is registered by its owner, with a title jobs never wrote', () => {
    for (const code of JOB_BORROWED_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title.length).toBeGreaterThan(0);
    }
  });

  test('every code documents at the standard docs URL', () => {
    for (const code of JOB_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
