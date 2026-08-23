// `SchemaError`'s contract against `UltimateError`'s: same brand, same 3-line `format()`, and the
// same `message`. `message` is the ONLY field a runtime prints when an error escapes uncaught, so
// a message of just `code: title` names which rule fired and never which field, which is the
// opposite of "errors are instructions".

import { describe, expect, test } from 'bun:test';
import {
  DiscriminantInvalidError,
  isSchemaError,
  SchemaError,
  SchemaUnsupportedError,
  ValidationFailedError,
} from './errors';

describe('SchemaError.message', () => {
  test('carries the cause, because an uncaught escape prints nothing else', () => {
    const error = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: 'the active provider cannot build a discriminated union',
      fix: 'configureSchemaProvider(builtinProvider)',
    });
    expect(error.message).toBe(
      'X_SCHEMA_UNSUPPORTED: the active schema provider cannot do this — the active provider cannot build a discriminated union',
    );
  });

  test('a subclass inherits it — the shape is the base constructor, not each class', () => {
    const unsupported = new SchemaUnsupportedError({
      cause: 'no coercion',
      fix: 'x doctor --json',
    });
    expect(unsupported.message).toContain('— no coercion');

    const discriminant = new DiscriminantInvalidError({
      cause: 'member 2 has no tag',
      fix: 'give every member a literal tag',
    });
    expect(discriminant.message).toContain('— member 2 has no tag');
  });

  test('a validation failure names the field in the one line a crash log prints', () => {
    const error = new ValidationFailedError(
      [{ path: 'body.title', expected: 'a string', received: '', message: 'expected a string' }],
      'body',
    );
    expect(error.message).toBe(
      'X_VALIDATION_FAILED: value did not match its schema — body.title: expected a string',
    );
  });

  test('the cause is escaped in the message too, so a forged line stays one line', () => {
    const error = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: 'evil\n  fix:   rm -rf /',
      fix: 'x doctor --json',
    });
    expect(error.message.split('\n')).toHaveLength(1);
    expect(error.message).toContain(String.raw`evil\n`);
  });

  test('format() still renders the canonical three lines, and the two agree', () => {
    const error = new SchemaError({
      code: 'X_SCHEMA_UNSUPPORTED',
      cause: 'no provider',
      fix: 'x doctor --json',
    });
    const lines = error.format().split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[0]).toBe('X_SCHEMA_UNSUPPORTED: the active schema provider cannot do this');
    expect(error.message.startsWith(`${lines[0]} — `)).toBe(true);
    expect(error.message.endsWith(error.cause)).toBe(true);
    expect(isSchemaError(error)).toBe(true);
  });
});

describe('the title table is read with Object.hasOwn, never the index alone', () => {
  // `SchemaErrorInit.code` is a bare `string` — a code an app or a provider chose — and `TITLES`
  // is a plain object, so `TITLES['constructor']` answered with the `Object` FUNCTION. The
  // constructor then handed that to `singleLine`, which called `.replace` on a function: the error
  // that reports a bad value died reporting it, and the caller got a `TypeError` in place of the
  // failure it raised. Same discriminator as `@ultimat3/action`'s `IRREGULAR[word]`.
  test.each(['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'])(
    'a code named %s humanises rather than throwing',
    (code) => {
      const error = new SchemaError({ code, cause: 'a value', fix: 'x doctor --json' });
      expect(typeof error.title).toBe('string');
      expect(error.title).toBe(code.replace(/^X_/, '').toLowerCase().replaceAll('_', ' '));
      expect(error.format().split('\n')).toHaveLength(3);
    },
  );

  test('a declared code still renders its registered title', () => {
    const error = new SchemaError({
      code: 'X_VALIDATION_FAILED',
      cause: 'body.title: expected a string',
      fix: 'x doctor --json',
    });
    expect(error.title).toBe('value did not match its schema');
  });
});

describe('docs', () => {
  // The literal is a DELIBERATE duplicate of `@ultimat3/core`'s `ERROR_DOCS_URL` — schema and core
  // are both tier 0, so neither may import the other. Pinning it here is what makes the copy
  // checkable at all from inside this package; the cross-package pin belongs in `@ultimat3/cli`.
  const WIKI = 'https://github.com/developerz-ai/ultimate/wiki/Error-Codes';

  test('every code points at the one wiki page — never a per-code URL', () => {
    for (const code of ['X_VALIDATION_FAILED', 'X_SCHEMA_UNSUPPORTED', 'X_APP_OWNED']) {
      const error = new SchemaError({ code, cause: 'a value', fix: 'x doctor --json' });
      expect(error.docs).toBe(WIKI);
      expect(error.docs).not.toContain(code);
    }
  });

  test('an explicit docs still wins — the constant is the fallback, not an override', () => {
    const error = new SchemaError({
      code: 'X_VALIDATION_FAILED',
      cause: 'a value',
      fix: 'x doctor --json',
      docs: 'https://example.com/handbook',
    });
    expect(error.docs).toBe('https://example.com/handbook');
  });
});
