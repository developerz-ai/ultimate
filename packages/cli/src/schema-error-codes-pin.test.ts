// `@ultimat3/schema` is tier 0 like `@ultimat3/core` and cannot register its own error codes or
// import core to read them back — so `@ultimat3/core`'s `schema-error-codes.ts` carries a
// deliberate duplicate of `SCHEMA_ERROR_CODES`. Neither tier-0 package can check that duplicate
// against its source, so the pin lives here: `@ultimat3/cli` is tier 5 and may legally import
// both. A title edited in one file and not the other fails this test instead of quietly
// disagreeing between "x errors explain" and the schema package's own `SchemaError.format()`.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode, SCHEMA_ERROR_CODE_TITLES } from '@ultimat3/core';
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
});
