// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. `x verify` shows these codes verbatim, so a silent drift here is a silent drift
// for every developer and every agent reading the gate.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { MANIFEST_ERROR_CODES, MANIFEST_ERROR_TITLES, ManifestBreakingError } from './errors';

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
      expect(describeErrorCode(code).docs).toBe(ERROR_DOCS_URL);
    }
  });
});

/**
 * The message an app meets the FIRST time this gate fires, asserted as text because text is the
 * whole product of an error: three separate things in it were wrong, and every one of them sent a
 * reader somewhere that cannot work.
 */
describe('X_MANIFEST_BREAKING says something a reader can act on', () => {
  const changes = ['actions.publishPost: action removed'];

  test('the first-fire shape does not describe a comparison that moved', () => {
    // `from === to` is GUARANTEED here, not an edge case: the drift gate forces the committed
    // manifest to match the code in any green state, so both sides read the same package.json.
    const error = new ManifestBreakingError({ changes, from: '0.1.0', to: '0.1.0' });
    expect(error.cause).toBe(
      '1 breaking change(s) against the committed x.manifest.json, with package.json unchanged at 0.1.0: actions.publishPost: action removed',
    );
    expect(error.cause).not.toContain('from 0.1.0 to 0.1.0');
  });

  test('a version that really did move keeps the comparison', () => {
    const error = new ManifestBreakingError({ changes, from: '1.4.2', to: '1.5.0' });
    expect(error.cause).toBe(
      '1 breaking change(s) from 1.4.2 to 1.5.0 with no major version bump: actions.publishPost: action removed',
    );
  });

  /**
   * `AppConfig` has no `version` field and `defineConfig` excess-property-checks its literal, so
   * the old line — "bump the major version in app.config.ts" — fails typecheck when followed
   * literally. The version is read from `package.json`.
   */
  test('the fix names package.json, the file the version is actually read from', () => {
    for (const from of ['1.4.2', '0.1.0', 'next']) {
      const fix = new ManifestBreakingError({ changes, from, to: from }).fix;
      expect(fix, from).toContain('package.json');
      expect(fix, from).not.toContain('app.config.ts');
    }
  });

  /**
   * `x new` scaffolds an app at `0.1.0`, and `majorOf` compares leading integers only — so the one
   * instruction the old line gave demanded `1.0.0` of an app with no published clients, and
   * `0.2.0` would not have satisfied it either.
   */
  test('a never-shipped 0.x app is offered the action that fits it', () => {
    const fix = new ManifestBreakingError({ changes, from: '0.1.0', to: '0.1.0' }).fix;
    expect(fix).toContain('x manifest');
    expect(fix).toContain('bun pm pkg set version=1.0.0');
    // The half a reader would otherwise discover by trying it: 0.2.0 is not a major bump here.
    expect(fix).toContain('0.2.0 does not');
  });

  test('a shipped app is told to raise the leading integer, not to re-commit a baseline', () => {
    const fix = new ManifestBreakingError({ changes, from: '1.4.2', to: '1.5.0' }).fix;
    expect(fix).toContain('bump the major version in package.json');
    expect(fix).not.toContain('x manifest');
  });

  // A version with no recognisable major falls to the stricter branch: a guess is never the
  // permissive one, which is the same fail-closed rule `verify.ts`'s own majorOf holds to.
  test('an unparseable version gets the shipped-app instruction, never the 0.x one', () => {
    expect(new ManifestBreakingError({ changes, from: 'next', to: 'next' }).fix).not.toContain(
      'x manifest',
    );
  });
});
