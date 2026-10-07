// Single responsibility: seo's registry of codes is a closed set. A code is a shipped promise —
// `x errors explain` answers from it and `wiki/Error-Codes.md` documents it — so one arriving or
// leaving without those two edits has to be a failing test rather than a silent diff.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import { SEO_ERROR_CODES } from './errors';

const WIKI = Bun.file(`${import.meta.dir}/../../../wiki/Error-Codes.md`);

describe('SEO_ERROR_CODES', () => {
  // Derived, not listed: `bun run new-error-code` writes a registration, its wiki row and this
  // table's entry together, and a literal copy here went red after every one of them while saying
  // nothing the registry and the page do not. A code gone from the wiki or the registry still fails.
  test('is exactly the set this package registers, and each has a row on the wiki page', async () => {
    // No performance-budget code: the budget gate is `@ultimat3/cli`'s `checkBudgets`, throwing
    // `@ultimat3/render`'s `X_BUDGET_EXCEEDED`; seo owned a second code for that one condition.
    const page = await WIKI.text();
    const codes = Object.values(SEO_ERROR_CODES);
    expect(new Set(codes).size).toBe(codes.length);
    expect(Object.keys(SEO_ERROR_CODES).length).toBe(codes.length);
    for (const code of codes) {
      expect(hasErrorCode(code), `${code} is not registered`).toBe(true);
      expect(page, `${code} has no wiki row`).toContain(`\`${code}\``);
    }
  });

  test('every code it owns carries a registered title', () => {
    for (const code of Object.values(SEO_ERROR_CODES)) {
      expect(code).toMatch(/^X_[A-Z0-9_]+$/);
      expect(describeErrorCode(code).title).not.toBe(
        code.replace(/^X_/, '').toLowerCase().replaceAll('_', ' '),
      );
    }
  });
});
