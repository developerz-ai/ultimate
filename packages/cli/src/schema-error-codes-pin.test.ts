// `@ultimat3/schema` is tier 0 like `@ultimat3/core` and cannot register its own error codes or
// import core to read them back — so `@ultimat3/core`'s `schema-error-codes.ts` carries a
// deliberate duplicate of `SCHEMA_ERROR_CODES`. Neither tier-0 package can check that duplicate
// against its source, so the pin lives here: `@ultimat3/cli` is tier 5 and may legally import
// both. A title edited in one file and not the other fails this test instead of quietly
// disagreeing between "x errors explain" and the schema package's own `SchemaError.format()`.

import { describe, expect, test } from 'bun:test';
import {
  classifyThrown,
  declaredErrorRetry,
  describeErrorCode,
  hasErrorCode,
  SCHEMA_ERROR_CODE_TITLES,
  UltimateError,
} from '@ultimat3/core';
import { SCHEMA_ERROR_CODES } from '@ultimat3/schema';

describe('core registers schema error codes', () => {
  test("titles core carries match schema's own declarations exactly", () => {
    const schemaTitles = Object.fromEntries(
      Object.entries(SCHEMA_ERROR_CODES).map(([code, declaration]) => [code, declaration.title]),
    );
    expect(SCHEMA_ERROR_CODE_TITLES).toEqual(schemaTitles);
  });

  test('core names exactly the codes schema owns, no more, no fewer', () => {
    expect(Object.keys(SCHEMA_ERROR_CODE_TITLES).sort()).toEqual(
      Object.keys(SCHEMA_ERROR_CODES).sort(),
    );
  });

  test('every schema code is registered process-wide just by importing @ultimat3/core', () => {
    for (const [code, declaration] of Object.entries(SCHEMA_ERROR_CODES)) {
      expect(hasErrorCode(code)).toBe(true);
      expect(describeErrorCode(code).title).toBe(declaration.title);
    }
  });

  test('every schema code is DECLARED terminal, not merely defaulted to it', () => {
    // `retryFor()` is the wrong question here and asserting it is a test that cannot fail:
    // `DEFAULT_ERROR_RETRY` is already `'terminal'`, so it answers `'terminal'` for a code nobody
    // ever registered. `error-retry.ts:162` is what makes the difference load-bearing — an error
    // carrying the DEFAULT classification is only reported by `classifyThrown` when its code was
    // explicitly declared, and `undefined` is what lets the attempt count govern.
    //
    // Measured before this landed: `@ultimat3/scraping` spent five browser launches on a page
    // carrying a `<div constructor="…">` — five navigations, five arrivals at a login — and
    // dead-lettered claiming the browser went away, about a browser that answered perfectly.
    //
    // Over `SCHEMA_ERROR_CODES` rather than a literal list, so a code schema adds later fails
    // here — which is the whole reason a classification is easy to forget.
    for (const code of Object.keys(SCHEMA_ERROR_CODES)) {
      expect(declaredErrorRetry(code), `${code} is declared`).toBe('terminal');
    }
  });

  test('the job path reports it — classifyThrown, which is what nextRetryForError reads', () => {
    for (const code of Object.keys(SCHEMA_ERROR_CODES)) {
      const thrown = new UltimateError({ code, cause: 'a probe', fix: 'x errors list --json' });
      expect(classifyThrown(thrown), `${code} classifies`).toBe('terminal');
    }
  });
});
