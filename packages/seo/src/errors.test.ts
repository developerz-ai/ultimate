// Single responsibility: seo's registry of codes is a closed set. A code is a shipped promise —
// `x errors explain` answers from it and `wiki/Error-Codes.md` documents it — so one arriving or
// leaving without those two edits has to be a failing test rather than a silent diff.

import { describe, expect, test } from 'bun:test';
import { SEO_ERROR_CODES } from './errors';

describe('SEO_ERROR_CODES', () => {
  test('is exactly the set this package owns and can throw', () => {
    // No performance-budget code: the budget gate is `@ultimat3/cli`'s `checkBudgets`, throwing
    // `@ultimat3/render`'s `X_BUDGET_EXCEEDED`. seo owned a second code for that one condition and
    // nothing but its own test ever threw it, so an agent handed `X_SEO_BUDGET_EXCEEDED` had a fix
    // line for a check no step of `x verify` runs.
    expect([...Object.values(SEO_ERROR_CODES)].sort()).toEqual([
      'X_IMAGE_QUERY_INVALID',
      'X_LD_INVALID',
      'X_SEO_CANONICAL_MISMATCH',
      'X_SEO_DUPLICATE_META',
      'X_SEO_META_MISSING',
      'X_SEO_META_TOO_LONG',
      'X_SITEMAP_TOO_LARGE',
    ]);
  });

  test('every code it owns carries a registered title', () => {
    // The titles are registered from a literal beside the codes, so the two can drift apart in one
    // direction only — a code with no title renders as a bare `X_*` in every surface that prints it.
    for (const code of Object.values(SEO_ERROR_CODES)) {
      expect(code).toMatch(/^X_[A-Z0-9_]+$/);
    }
  });
});
