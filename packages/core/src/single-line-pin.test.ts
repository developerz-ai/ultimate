// Pins `@ultimat3/schema`'s deliberate copies of two core declarations — `singleLine` and
// `ERROR_DOCS_URL` — against core's own, and that the brand symbol is ONE declaration: schema's,
// which core imports.
//
// THIS IS THE HALF THE `core -> schema` EDGE DOES NOT FIX, which is why it is the one pin that
// survives. The five copies on the CORE side are gone: core imports them from schema now, and
// `currency-pattern-pin`, `describe-value-pin`, `schema-error-codes-pin` and
// `timezone-validator-pin` were deleted with them. The brand went the same way in 25.0.0: core
// imports schema's. These two go the other way — SCHEMA copies CORE — and `schema -> core` stays
// forbidden on its merits: schema must import nothing, because `t` is in every bundle graph an app
// has.
//
// It moved here from `@ultimat3/cli` on 2026-08-27. It lived at tier 5 because that was the lowest
// tier able to import both; core can now import schema, so a tier-0 invariant is pinned at tier 0,
// beside the declarations it is about.
//
// Behavioural, on `format()`: the contract is "the 3-line format stays three lines whoever renders
// it", and exporting a private escape to test it would widen the public surface to describe an
// implementation.

import { describe, expect, test } from 'bun:test';
import { SchemaError, ULTIMATE_ERROR_BRAND } from '@ultimat3/schema';
import { ERROR_DOCS_URL } from './error-codes';
import { isUltimateError, UltimateError } from './errors';

/** Closes the sentence, then forges a whole framework line. */
const FORGED = 'evil\n  fix:   rm -rf /\nX_OK: everything is fine';

const bodyOf = (rendered: string): readonly string[] => rendered.split('\n').slice(1);

/**
 * A drifted copy fails here instead of quietly letting a schema cause — which describes the value
 * that failed validation, i.e. the request body — write a line an operator reads as genuine.
 */
describe('schema and core escape a hostile cause identically', () => {
  test('both render exactly three lines', () => {
    const core = new UltimateError({ code: 'X_INVARIANT', cause: FORGED, fix: FORGED });
    const schema = new SchemaError({ code: 'X_SCHEMA_UNSUPPORTED', cause: FORGED, fix: FORGED });
    expect(core.format().split('\n')).toHaveLength(3);
    expect(schema.format().split('\n')).toHaveLength(3);
  });

  test('the cause and fix lines are byte-identical between the two renderers', () => {
    const core = new UltimateError({ code: 'X_INVARIANT', cause: FORGED, fix: FORGED });
    const schema = new SchemaError({ code: 'X_SCHEMA_UNSUPPORTED', cause: FORGED, fix: FORGED });
    // Only the head line differs — different code, different title. The body is the contract.
    expect(bodyOf(schema.format())).toEqual(bodyOf(core.format()));
  });

  test('every control character both must escape is escaped the same way', () => {
    // `\u2028`/`\u2029` included: they end a line for a JS parser and several log viewers while
    // splitting on `\n` never sees them, which is exactly the kind of gap a drifted copy opens.
    const controls = ['\n', '\r', '\t', '\b', '\f', '\x00', '\x1b', '\x7f', '\u2028', '\u2029'];
    for (const control of controls) {
      const cause = `a${control}b`;
      const core = new UltimateError({ code: 'X_INVARIANT', cause, fix: 'x doctor --json' });
      const schema = new SchemaError({
        code: 'X_SCHEMA_UNSUPPORTED',
        cause,
        fix: 'x doctor --json',
      });
      expect(bodyOf(schema.format())).toEqual(bodyOf(core.format()));
      // The format's own two newlines are legitimate; the control must not add a third line.
      expect(schema.format().split('\n')).toHaveLength(3);
      expect(bodyOf(schema.format()).join('')).not.toInclude(control);
    }
  });

  /**
   * `packages/schema/src/errors.ts` spells this URL out because it may not import core's
   * `ERROR_DOCS_URL`, and its own doc-block said the pin for it "is NOT written yet" — so the one
   * copy with no mechanical check was the one that decides where every schema refusal sends its
   * reader. `wiki/` has no per-code anchor, so a wrong host here is a 404 and not a wrong section;
   * `bun run dead-docs-host` already refuses `ultimate.dev`, and this refuses a drift to anything.
   */
  test('both send a reader to the same docs URL, which was the copy nothing pinned', () => {
    const core = new UltimateError({ code: 'X_INVARIANT', cause: 'c', fix: 'x doctor --json' });
    const schema = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: 'c',
      fix: 'x doctor --json',
    });
    expect(schema.docs).toBe(core.docs);
    expect(core.docs).toBe(ERROR_DOCS_URL);
  });

  /**
   * One declaration, not two equal ones: core's export IS schema's binding. A second
   * `Symbol.for(…)` on the core side would still compare equal, so the identity of the BINDING is
   * held by `scripts/factory-names.ts` (one value name, one declaring package); this holds the
   * behaviour — a typo'd key makes `isUltimateError()` false for every schema refusal.
   */
  test('a SchemaError is an UltimateError to the brand check', () => {
    const schema = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: 'c',
      fix: 'x doctor --json',
    });
    expect<symbol>(ULTIMATE_ERROR_BRAND).toBe(Symbol.for('ultimate.error'));
    expect(
      ULTIMATE_ERROR_BRAND in
        new UltimateError({ code: 'X_INVARIANT', cause: 'c', fix: 'x doctor --json' }),
    ).toBe(true);
    expect(Symbol.for('ultimate.error') in schema).toBe(true);
    expect(isUltimateError(schema)).toBe(true);
  });

  test('ordinary prose passes through both unchanged', () => {
    const prose = 'expected string, received number at posts[0].title';
    const core = new UltimateError({ code: 'X_INVARIANT', cause: prose, fix: 'x doctor --json' });
    const schema = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: prose,
      fix: 'x doctor --json',
    });
    expect(core.format()).toInclude(prose);
    expect(schema.format()).toInclude(prose);
  });
});
