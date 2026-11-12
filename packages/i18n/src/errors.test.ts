// A registered error code is a contract: hasErrorCode() must see it, describeErrorCode()
// must render the title this package declared, and every code must resolve to its docs
// page. These tests are what keeps that contract from rotting silently.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, ERROR_DOCS_URL, hasErrorCode } from '@ultimat3/core';
import { loadCatalog } from './catalog';
import { catalogInvalid, I18N_ERROR_CODES, I18N_ERROR_TITLES } from './errors';

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

// `"admin.posts.title": "Posts"` is the key `X_CATALOG_MISSING_KEYS` names, written the way it was
// named — and the fix this refusal printed was `x i18n check --json`, the command that refused it.
describe('X_CATALOG_INVALID for a dotted key', () => {
  test('the fix is the nested shape, and pasting it loads', () => {
    let fix = '';
    try {
      loadCatalog({ 'admin.posts.title': 'Posts' });
    } catch (error) {
      expect((error as { code?: unknown }).code).toBe('X_CATALOG_INVALID');
      fix = (error as { fix: string }).fix;
    }
    const pasted: unknown = JSON.parse(fix.split('#')[0] ?? '');
    expect(Object.keys(loadCatalog(pasted))).toEqual(['admin.posts.title']);
    expect(fix).toContain('x i18n sync');
  });

  test('a segment nesting cannot repair keeps the check', () => {
    expect(catalogInvalid('a b', 'key segments must match /^[A-Za-z0-9_-]+$/').fix).toBe(
      'x i18n check --json',
    );
  });
});
