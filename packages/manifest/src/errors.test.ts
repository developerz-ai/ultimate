// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. `x verify` shows these codes verbatim, so a silent drift here is a silent drift
// for every developer and every agent reading the gate.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { MANIFEST_ERROR_CODES, MANIFEST_ERROR_TITLES } from './errors';

describe('MANIFEST_ERROR_TITLES', () => {
  test('has exactly one title per declared code, and no extras', () => {
    const titled = Object.keys(MANIFEST_ERROR_TITLES).sort();
    const declared = [...MANIFEST_ERROR_CODES].sort();
    expect(titled).toEqual(declared);
  });
});

describe('registration', () => {
  test('every declared code is registered in the framework-wide registry', () => {
    for (const code of MANIFEST_ERROR_CODES) {
      expect(hasErrorCode(code)).toBe(true);
    }
  });

  test('describeErrorCode renders the title this package declared', () => {
    for (const code of MANIFEST_ERROR_CODES) {
      expect(describeErrorCode(code).title).toBe(MANIFEST_ERROR_TITLES[code]);
    }
  });
});

describe('docs', () => {
  test('every code resolves to its canonical docs page', () => {
    for (const code of MANIFEST_ERROR_CODES) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});
