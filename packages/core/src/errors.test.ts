import { afterAll, describe, expect, test } from 'bun:test';
import {
  describeErrorCode,
  errorCodeSnapshot,
  hasErrorCode,
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

// Every package registers its codes once, at import time, and bun shares one process across
// files. The resets below would otherwise strip whatever ran before this file — `@ultimat3/db`'s
// `X_DB_DRIFT` then renders as `db drift` in a later file, which is a load-order flake rather
// than a failure. Same guard, same reason as packages/testing/src/fixtures.test.ts.
const restoreRegistry = errorCodeSnapshot();

afterAll(restoreRegistry);

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
    expect(formatError('boom')).toContain('non-error value thrown: "boom"');
  });

  test('toUltimateError survives a value that fights being rendered', () => {
    // This function is the framework's universal normaliser — `formatError`, every CLI catch, the
    // HTTP pipeline's 500 path. If it throws while describing what was thrown, the process loses
    // BOTH errors and the surface that called it has nothing to answer with.
    const hostile = {
      toString: () => {
        throw new Error('gotcha');
      },
    };
    const wrapped = toUltimateError(hostile);
    expect(wrapped.code).toBe('X_INTERNAL');
    expect(wrapped.sourceError).toBe(hostile);
    expect(wrapped.cause).toContain('non-error value thrown');
  });

  // `--json` on every error is a house rule, and `toJSON()` is the whole of it. `meta` is the one
  // field on it that carries values the framework does not control — `parseId` puts the rejected
  // value straight in — so a bigint, a cycle or a hostile `toJSON` in there threw at RENDER time,
  // one surface past the constructor the renderers already guard.
  describe('toJSON over a meta the framework does not control', () => {
    const withMeta = (meta: Readonly<Record<string, unknown>>): UltimateError =>
      new UltimateError({ code: 'X_ID_INVALID', cause: 'c', fix: 'f', meta });

    const unrenderable = (): ReadonlyMap<string, unknown> => {
      const cyclic: Record<string, unknown> = {};
      cyclic['self'] = cyclic;
      return new Map<string, unknown>([
        ['a bigint', 10n],
        ['a cycle', cyclic],
        [
          'a hostile toJSON',
          {
            toJSON: () => {
              throw new Error('gotcha');
            },
          },
        ],
      ]);
    };

    for (const [label, value] of unrenderable()) {
      test(`serialises with ${label} in meta instead of throwing`, () => {
        const error = withMeta({ kind: 'post', value });
        let json = '';
        expect(() => {
          json = JSON.stringify(error);
        }).not.toThrow();
        expect(json).toContain('X_ID_INVALID');
        // The keys BESIDE the broken one survive: one value nobody can render must not cost the
        // reader the rest of the record.
        expect(JSON.parse(json).meta.kind).toBe('post');
      });
    }

    test('passes a meta that serialises through untouched, value identity included', () => {
      // `meta` is machine-read. Describing a value that renders today would be a worse bug than
      // the throw, so the pass-through is the property under test, not a nice-to-have.
      const value = { id: 7, nested: { at: [1, 2] } };
      const error = withMeta({ kind: 'post', value });
      expect(error.toJSON().meta).toEqual({ kind: 'post', value });
      expect((error.toJSON().meta as Record<string, unknown>)['value']).toBe(value);
      expect(JSON.parse(JSON.stringify(error)).meta).toEqual({ kind: 'post', value });
    });

    test('a meta whose own toJSON is a function does not throw one layer out', () => {
      // The subtle half of the same bug: `JSON.stringify(fn)` answers `undefined` rather than
      // throwing, so the probe called a function renderable and copied it through — and a `toJSON`
      // key is then INVOKED while serialising the record around it, at `--json` time.
      const error = withMeta({
        kind: 'post',
        toJSON: () => {
          throw new Error('gotcha');
        },
      });

      let json = '';
      expect(() => {
        json = JSON.stringify(error);
      }).not.toThrow();
      expect(JSON.parse(json).meta.kind).toBe('post');
    });

    test('a record that cannot be enumerated at all still renders the error', () => {
      const error = withMeta(
        new Proxy(
          {},
          {
            ownKeys: () => {
              throw new Error('gotcha');
            },
          },
        ),
      );
      expect(() => JSON.stringify(error)).not.toThrow();
      expect(JSON.parse(JSON.stringify(error)).code).toBe('X_ID_INVALID');
    });

    test('an unreadable key degrades alone', () => {
      const error = withMeta(
        Object.defineProperty({ kind: 'post' }, 'value', {
          enumerable: true,
          get: () => {
            throw new Error('gotcha');
          },
        }),
      );
      expect(() => JSON.stringify(error)).not.toThrow();
      expect(JSON.parse(JSON.stringify(error)).meta.kind).toBe('post');
    });

    test('no meta stays absent rather than becoming an empty object', () => {
      expect(new UltimateError({ code: 'X_ID_INVALID', cause: 'c', fix: 'f' }).toJSON().meta).toBe(
        undefined,
      );
    });
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

  test('a snapshot hands the registry back exactly, so a reset cannot leak across files', () => {
    registerErrorCodes({ X_PKG_TWO: { title: 'a package registered this at import time' } });
    const restore = errorCodeSnapshot();

    resetErrorCodes();
    expect(hasErrorCode('X_PKG_TWO')).toBe(false);
    // The fallback is what a later file would see: a humanised title instead of the pinned one.
    expect(describeErrorCode('X_PKG_TWO').title).toBe('pkg two');

    restore();
    expect(describeErrorCode('X_PKG_TWO').title).toBe('a package registered this at import time');
  });

  test('lists codes sorted for stable --json output', () => {
    const codes = listErrorCodes().map((entry) => entry.code);
    expect(codes).toEqual([...codes].sort());
    expect(codes).toContain('X_ENV_MISSING');
  });
});
