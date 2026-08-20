// Pins `@ultimat3/schema`'s deliberate copy of core's `singleLine` against core's own, since both
// are tier 0 and schema may not import core. Behavioural, on `format()`: the contract is "the
// 3-line format stays three lines whoever renders it", and exporting a private escape to test it
// would widen the public surface to describe an implementation. Same arrangement as the tier-0 pins.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { SchemaError } from '@ultimat3/schema';

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
