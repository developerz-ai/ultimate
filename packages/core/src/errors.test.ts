import { describe, expect, test } from 'bun:test';
import {
  describeErrorCode,
  listErrorCodes,
  registerErrorCodes,
  resetErrorCodes,
} from './error-codes';
import {
  ConfigInvalidError,
  formatError,
  isUltimateError,
  notImplemented,
  toUltimateError,
  UltimateError,
} from './errors';

describe('UltimateError', () => {
  test('renders the contract 3-line format with aligned labels', () => {
    resetErrorCodes();
    registerErrorCodes({ X_DB_DRIFT: { title: 'schema differs from migrations' } });
    const error = new UltimateError({
      code: 'X_DB_DRIFT',
      cause: 'table "posts" has column "publish_at" not present in any migration',
      fix: 'x db gen "add publish_at"',
    });

    expect(error.format()).toBe(
      [
        'X_DB_DRIFT: schema differs from migrations',
        '  cause: table "posts" has column "publish_at" not present in any migration',
        '  fix:   x db gen "add publish_at"',
      ].join('\n'),
    );
    expect(error.format().split('\n')).toHaveLength(3);
    expect(error.format({ docs: true }).split('\n')[3]).toBe(
      '  docs:  https://ultimate.dev/errors/X_DB_DRIFT',
    );
    resetErrorCodes();
  });

  test('toJSON is stable and includes the resolved title and docs url', () => {
    const error = new ConfigInvalidError({
      cause: 'defaultLocale "de" is not in locales',
      fix: 'edit app.config.ts',
      meta: { field: 'defaultLocale' },
    });
    const json = JSON.parse(JSON.stringify(error)) as Record<string, unknown>;

    expect(json['code']).toBe('X_CONFIG_INVALID');
    expect(json['title']).toBe('app.config.ts is invalid');
    expect(json['docs']).toBe('https://ultimate.dev/errors/X_CONFIG_INVALID');
    expect(json['cause']).toBe('defaultLocale "de" is not in locales');
    expect(json['fix']).toBe('edit app.config.ts');
    expect(json['meta']).toEqual({ field: 'defaultLocale' });
    // The cause is part of `message` on purpose: an uncaught error prints only `message`,
    // and a title without the offending value is not an instruction.
    expect(error.message).toBe(
      'X_CONFIG_INVALID: app.config.ts is invalid — defaultLocale "de" is not in locales',
    );
  });

  test('is duck-typed so cross-package errors still match the guard', () => {
    const foreign = { [Symbol.for('ultimate.error')]: true, code: 'X_VALIDATION_FAILED' };
    expect(isUltimateError(foreign)).toBe(true);
    expect(isUltimateError(new Error('plain'))).toBe(false);
    expect(isUltimateError(undefined)).toBe(false);
  });

  test('unknown codes still render a deterministic humanised title', () => {
    expect(describeErrorCode('X_SOMETHING_ODD').title).toBe('something odd');
  });

  test('toUltimateError wraps foreign throws without losing the original', () => {
    const original = new TypeError('nope');
    const wrapped = toUltimateError(original);
    expect(wrapped.code).toBe('X_INTERNAL');
    expect(wrapped.cause).toBe('TypeError: nope');
    expect(wrapped.sourceError).toBe(original);
    expect(formatError('boom')).toContain('non-error value thrown: boom');
  });

  test('notImplemented always carries a fix line', () => {
    expect(() => notImplemented('s3 driver', 'x storage use local')).toThrow(/X_NOT_IMPLEMENTED/);
    try {
      notImplemented('s3 driver', 'x storage use local');
    } catch (thrown) {
      expect(isUltimateError(thrown)).toBe(true);
      expect((thrown as UltimateError).fix).toBe('x storage use local');
    }
  });
});

describe('error code registry', () => {
  test('rejects duplicate codes so two packages cannot disagree', () => {
    resetErrorCodes();
    registerErrorCodes({ X_PKG_ONE: { title: 'one' } });
    expect(() => registerErrorCodes({ X_PKG_ONE: { title: 'different' } })).toThrow(
      /X_ERROR_CODE_DUPLICATE/,
    );
    expect(() => registerErrorCodes({ X_CONFIG_INVALID: { title: 'hijack' } })).toThrow(
      /X_ERROR_CODE_DUPLICATE/,
    );
    resetErrorCodes();
  });

  test('lists codes sorted for stable --json output', () => {
    const codes = listErrorCodes().map((entry) => entry.code);
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain('X_ENV_MISSING');
  });
});
