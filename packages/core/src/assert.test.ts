// Direct coverage: compile-time-backed runtime assertions — `assertNever`, `invariant`, `assert`.

import { describe, expect, test } from 'bun:test';
import { assert, assertNever, invariant } from './assert';
import { isUltimateError, type UltimateError } from './errors';

describe('assertNever', () => {
  test('always throws UltimateError X_UNREACHABLE, cause includes JSON.stringify(value) for a JSON-serializable value', () => {
    type Shape = { kind: 'circle'; radius: number } | { kind: 'square'; side: number };
    const bogus = { kind: 'triangle', sides: 3 } as unknown as never;

    let caught: unknown;
    try {
      assertNever(bogus);
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_UNREACHABLE');
    expect(error.cause).toContain(JSON.stringify(bogus));
    expect(error.fix).toBe('add a case for the variant named in cause');

    // Exercises the TYPE contract too: a switch over a 2-member union whose default is
    // unreachable only typechecks if `assertNever` narrows the parameter to `never`.
    const describe2 = (shape: Shape): string => {
      switch (shape.kind) {
        case 'circle':
          return 'circle';
        case 'square':
          return 'square';
        default:
          return assertNever(shape);
      }
    };
    expect(describe2({ kind: 'circle', radius: 1 })).toBe('circle');
  });

  test('falls back to String(value) when JSON.stringify cannot render the value (e.g. undefined)', () => {
    let caught: unknown;
    try {
      assertNever(undefined as never);
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_UNREACHABLE');
    // JSON.stringify(undefined) === undefined, which is falsy, triggering the `?? String(value)`
    // fallback — the cause must carry the String() rendering, not the literal word "undefined"
    // from a broken template, and definitely not throw while formatting.
    expect(error.cause).toContain(String(undefined));
    expect(error.cause).toContain('unhandled variant:');
  });

  test('a custom fix argument is used verbatim instead of the generic default', () => {
    let caught: unknown;
    try {
      assertNever('bad' as unknown as never, 'add the "bad" branch to the switch');
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as UltimateError).fix).toBe('add the "bad" branch to the switch');
  });
});

describe('invariant', () => {
  test('a truthy condition returns without throwing and without side effects', () => {
    expect(() => invariant(true, 'X_TEST', 'unreachable cause', 'unreachable fix')).not.toThrow();
    expect(() => invariant(1, 'X_TEST', 'unreachable cause', 'unreachable fix')).not.toThrow();
    expect(() => invariant('non-empty', 'X_TEST', 'c', 'f')).not.toThrow();
  });

  test('a falsy condition throws UltimateError with exactly the given code/cause/fix', () => {
    let caught: unknown;
    try {
      invariant(false, 'X_SOME_CODE', 'the thing that actually happened', 'do the exact fix');
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_SOME_CODE');
    expect(error.cause).toBe('the thing that actually happened');
    expect(error.fix).toBe('do the exact fix');
  });

  test('falsy conditions covered: 0, "", null, undefined, NaN all throw', () => {
    for (const falsy of [0, '', null, undefined, Number.NaN]) {
      expect(() => invariant(falsy, 'X_TEST', 'c', 'f')).toThrow();
    }
  });

  test('options.docs and options.meta pass through onto the thrown error when provided', () => {
    let caught: unknown;
    try {
      invariant(false, 'X_TEST', 'c', 'f', {
        docs: 'https://example.test/docs/x-test',
        meta: { key: 'value', n: 1 },
      });
    } catch (thrown) {
      caught = thrown;
    }
    const error = caught as UltimateError;
    expect(error.docs).toBe('https://example.test/docs/x-test');
    expect(error.meta).toEqual({ key: 'value', n: 1 });
  });

  test('docs/meta are undefined when options is omitted', () => {
    let caught: unknown;
    try {
      invariant(false, 'X_TEST', 'c', 'f');
    } catch (thrown) {
      caught = thrown;
    }
    const error = caught as UltimateError;
    expect(error.meta).toBeUndefined();
    // `docs` falls back to the error-code registry's description when not given — it is
    // populated by `describeErrorCode`, never left `undefined`, so it must be a string here.
    expect(typeof error.docs).toBe('string');
  });
});

describe('assert', () => {
  test('a truthy condition returns without throwing', () => {
    expect(() => assert(true, 'unreachable cause', 'unreachable fix')).not.toThrow();
  });

  test('a falsy condition throws UltimateError with the hardcoded code X_INVARIANT, regardless of arguments', () => {
    let caught: unknown;
    try {
      assert(false, 'the specific thing that broke', 'the specific fix to run');
    } catch (thrown) {
      caught = thrown;
    }
    expect(isUltimateError(caught)).toBe(true);
    const error = caught as UltimateError;
    expect(error.code).toBe('X_INVARIANT');
    expect(error.cause).toBe('the specific thing that broke');
    expect(error.fix).toBe('the specific fix to run');
  });

  test('the code is always X_INVARIANT even when the cause text mentions a different code', () => {
    let caught: unknown;
    try {
      assert(false, 'X_ROLE_INVALID would be wrong here', 'fix it');
    } catch (thrown) {
      caught = thrown;
    }
    expect((caught as UltimateError).code).toBe('X_INVARIANT');
  });
});
