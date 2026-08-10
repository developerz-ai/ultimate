// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. These tests are what keeps that contract from rotting silently.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  ADMIN_BORROWED_ERROR_CODES,
  ADMIN_ERROR_CODES,
  ADMIN_ERROR_TITLES,
  ADMIN_OWNED_ERROR_CODES,
} from './errors';

describe('ADMIN_ERROR_TITLES', () => {
  test('titles exactly the codes admin owns — a borrowed code carries no title here', () => {
    expect(Object.keys(ADMIN_ERROR_TITLES).sort()).toEqual([...ADMIN_OWNED_ERROR_CODES].sort());
  });

  test('owned and borrowed are disjoint and together are every code admin throws', () => {
    const owned = new Set<string>(ADMIN_OWNED_ERROR_CODES);
    for (const code of ADMIN_BORROWED_ERROR_CODES) expect(owned.has(code)).toBe(false);
    expect([...ADMIN_ERROR_CODES].sort()).toEqual(
      [...ADMIN_OWNED_ERROR_CODES, ...ADMIN_BORROWED_ERROR_CODES].sort(),
    );
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of ADMIN_OWNED_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(ADMIN_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered by admin', () => {
    // admin declares no title for it, so the string below can only have come from core.
    expect(describeErrorCode('X_NOT_IMPLEMENTED').title).toBe(
      'this driver does not implement the requested feature',
    );
  });
});

describe('docs', () => {
  test('every code resolves to its canonical docs page', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
