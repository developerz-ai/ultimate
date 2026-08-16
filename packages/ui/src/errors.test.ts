// Every code ui declares must carry a title, be registered after import, document at the
// standard URL, and each factory must actually throw the code it claims to own.

import { describe, expect, test } from 'bun:test';
import { describeErrorCode, hasErrorCode } from '@ultimat3/core';
import {
  invalidBrandTokenError,
  invalidThemeError,
  invalidValueError,
  runtimeMissingError,
  UI_ERROR_CODES,
  UiError,
  unknownTokenError,
} from './errors';

describe('UI_ERROR_CODES', () => {
  test('every declared code is registered with the expected title', () => {
    expect(hasErrorCode(UI_ERROR_CODES.tokenUnknown)).toBe(true);
    expect(describeErrorCode(UI_ERROR_CODES.tokenUnknown).title).toBe(
      'design token role does not exist',
    );
    expect(hasErrorCode(UI_ERROR_CODES.themeInvalid)).toBe(true);
    expect(describeErrorCode(UI_ERROR_CODES.themeInvalid).title).toBe(
      'theme is not "light" or "dark"',
    );
    expect(hasErrorCode(UI_ERROR_CODES.runtimeMissing)).toBe(true);
    expect(hasErrorCode(UI_ERROR_CODES.invalidValue)).toBe(true);
  });

  test('every code documents at the standard docs URL', () => {
    for (const code of Object.values(UI_ERROR_CODES)) {
      expect(describeErrorCode(code).docs).toBe(`https://ultimate.dev/errors/${code}`);
    }
  });
});

describe('unknownTokenError', () => {
  test('carries the token code, names the unknown role, and lists known roles', () => {
    const err = unknownTokenError('color', 'brand', ['accent', 'neutral']);
    expect(err).toBeInstanceOf(UiError);
    expect(err).toBeUltimateError(UI_ERROR_CODES.tokenUnknown);
    expect(err.cause).toContain('unknown color token "brand"');
    expect(err.cause).toContain('accent, neutral');
    expect(err.fix).toContain('_colors.scss');
  });
});

describe('invalidThemeError', () => {
  test('carries the theme code and echoes the bad value', () => {
    const err = invalidThemeError('purple');
    expect(err).toBeUltimateError(UI_ERROR_CODES.themeInvalid);
    expect(err.cause).toContain('"purple"');
    expect(err.fix).toContain("setTheme('light')");
  });

  test('handles non-string values via JSON.stringify', () => {
    const err = invalidThemeError(null);
    expect(err.cause).toContain('null');
  });
});

describe('runtimeMissingError', () => {
  test('names the missing capability and forwards the given fix', () => {
    const err = runtimeMissingError('matchMedia', 'run in a browser environment');
    expect(err).toBeUltimateError(UI_ERROR_CODES.runtimeMissing);
    expect(err.cause).toContain('matchMedia');
    expect(err.fix).toBe('run in a browser environment');
  });
});

describe('invalidValueError', () => {
  test('names the component kind, the bad value, and what was expected', () => {
    const err = invalidValueError('Money', Number.NaN, 'a finite Money value');
    expect(err).toBeUltimateError(UI_ERROR_CODES.invalidValue);
    expect(err.cause).toContain('<Money>');
    expect(err.cause).toContain('a finite Money value');
    expect(err.fix).toContain('a finite Money value');
  });
});

// Every one of these three factories takes the offending value as `unknown` and puts it in the
// `cause`: a `defineTheme()` override, a `data-theme` attribute or a stored preference, and
// whatever a formatting component was handed. `JSON.stringify` throws on a bigint and on a cycle
// and RUNS the value's own `toJSON`, so the refusal was replaced by the value's own throw and
// `X_UI_INVALID_VALUE` never reached the caller who could act on it.
describe('a value ui does not control still produces the refusal', () => {
  const hostile = (): ReadonlyMap<string, unknown> => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    return new Map<string, unknown>([
      ['a bigint', 12n],
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

  for (const [label, value] of hostile()) {
    test(`invalidThemeError refuses ${label}`, () => {
      let error: UiError | undefined;
      expect(() => {
        error = invalidThemeError(value);
      }).not.toThrow();
      expect(error?.code).toBe(UI_ERROR_CODES.themeInvalid);
    });

    test(`invalidValueError refuses ${label}`, () => {
      let error: UiError | undefined;
      expect(() => {
        error = invalidValueError('Money', value, 'a Money value');
      }).not.toThrow();
      expect(error?.code).toBe(UI_ERROR_CODES.invalidValue);
      expect(error?.cause).toStartWith('<Money> received ');
    });

    test(`invalidBrandTokenError refuses ${label}`, () => {
      let error: UiError | undefined;
      expect(() => {
        error = invalidBrandTokenError('colors.light', 'accent', value, 'three 0-255 channels');
      }).not.toThrow();
      expect(error?.code).toBe(UI_ERROR_CODES.invalidValue);
    });
  }

  test('a renderable value reads exactly as it did', () => {
    expect(invalidThemeError('dusk').cause).toBe(
      'theme must be "light" or "dark", received "dusk"',
    );
    expect(invalidValueError('Money', 3, 'a Money value').cause).toBe(
      '<Money> received 3, which is not a Money value',
    );
  });
});
