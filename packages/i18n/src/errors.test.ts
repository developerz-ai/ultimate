// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. These tests are what keeps that contract from rotting silently.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { I18N_ERROR_CODES, I18N_ERROR_TITLES } from './errors';

describe('I18N_ERROR_TITLES', () => {
  test('has exactly one title per declared code, and no extras', () => {
    const titled = Object.keys(I18N_ERROR_TITLES).sort();
    const declared = [...I18N_ERROR_CODES].sort();
    expect(titled).toEqual(declared);
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of I18N_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of I18N_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(I18N_ERROR_TITLES[code]);
    }
  });
});

describe('docs', () => {
  // Asserted against core's constant, never a literal: a hand-copied URL is exactly how the dead
  // `https://ultimate.dev/errors/<code>` host survived every suite in the tree. There is ONE page
  // and no per-code anchor, so the code must NOT appear in the link.
  test('every code resolves to the one docs page core declares', () => {
    for (const code of I18N_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
      expect(describeErrorCode(code).docs).not.toContain(code);
    }
  });
});
