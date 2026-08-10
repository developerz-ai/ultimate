// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. These tests are what keeps that contract from rotting silently.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { ADMIN_ERROR_CODES, ADMIN_ERROR_TITLES } from './errors';

describe('ADMIN_ERROR_TITLES', () => {
  test('has exactly one title per declared code, and no extras', () => {
    const titled = Object.keys(ADMIN_ERROR_TITLES).sort();
    const declared = [...ADMIN_ERROR_CODES].sort();
    expect(titled).toEqual(declared);
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of ADMIN_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(ADMIN_ERROR_TITLES[code]);
    }
  });

  test('X_NOT_IMPLEMENTED is borrowed from core, not re-registered by admin', () => {
    // admin/src/errors.ts guards this code with hasErrorCode() and never calls
    // registerErrorCodes() for it, so the title rendered here is core's — this pins that
    // fact instead of letting the loop above pass on a coincidence.
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
