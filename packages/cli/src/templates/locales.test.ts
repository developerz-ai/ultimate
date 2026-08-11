import { describe, expect, test } from 'bun:test';
import { thrownBy } from '../thrown-by';
import { catalogPath, DEFAULT_LOCALES, resolveLocales } from './locales';

describe('unit · the generated-catalog locale resolver', () => {
  test('no request is the default locale, and an all-blank request is too', () => {
    expect(resolveLocales()).toEqual(DEFAULT_LOCALES);
    expect(resolveLocales([])).toEqual(['en']);
    expect(resolveLocales(['', '  '])).toEqual(['en']);
  });

  test('tags are trimmed, canonicalized to a directory name and deduped', () => {
    expect(resolveLocales([' en ', 'EN', 'es'])).toEqual(['en', 'es']);
    // Canonical case for a region or a script, lowercased because the tag is a directory.
    expect(resolveLocales(['en-us', 'zh-Hant'])).toEqual(['en-us', 'zh-hant']);
  });

  test('order is the order asked for: the first locale is the one an app reads first', () => {
    expect(resolveLocales(['es', 'en'])).toEqual(['es', 'en']);
  });

  test('a traversal segment is a path escape, named as one', () => {
    for (const attack of ['../../../../tmp', '..', '.', 'en/../..', 'en\\..', '/etc']) {
      const failure = thrownBy(() => resolveLocales([attack]));
      expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
      expect(failure.fix).toBe('x g resource <name> --locales=en,es');
    }
  });

  test('the escape names the catalog root it would have left', () => {
    const failure = thrownBy(() => resolveLocales(['../../../../tmp']));
    expect(failure.cause).toContain('packages/i18n/catalogs/../../../../tmp');
    expect(failure.cause).toContain('resolves outside packages/i18n/catalogs');
  });

  test('a tag that is not BCP-47 is a bad flag, not a silent fallback to en', () => {
    for (const bogus of ['en_US', '1234', 'x-priv', 'enn-!']) {
      const failure = thrownBy(() => resolveLocales([bogus]));
      expect(failure.code).toBe('X_CLI_BAD_FLAG');
      expect(failure.cause).toContain(bogus);
    }
  });

  test("the rejection names the caller's own command and flag, not x g --locales", () => {
    const failure = thrownBy(() =>
      resolveLocales(['1234'], { fix: 'x i18n add es', command: 'i18n', flag: 'locale' }),
    );
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('--locale on "x i18n"');
    expect(failure.fix).toBe('x i18n add es');
  });

  test('a bare string second argument is still just the fix, on the x g default context', () => {
    const failure = thrownBy(() => resolveLocales(['1234'], 'x g route blog --locales=en,es'));
    expect(failure.cause).toContain('--locales on "x g"');
    expect(failure.fix).toBe('x g route blog --locales=en,es');
  });

  test('a path escape carries the same context, so both rejections agree on the caller', () => {
    const failure = thrownBy(() =>
      resolveLocales(['../etc'], { fix: 'x i18n add es', command: 'i18n', flag: 'locale' }),
    );
    expect(failure.code).toBe('X_SCAFFOLD_PATH_ESCAPE');
    expect(failure.fix).toBe('x i18n add es');
  });

  test('resolving an already-resolved list is a no-op, so call sites may chain', () => {
    expect(resolveLocales(resolveLocales(['EN', 'es']))).toEqual(['en', 'es']);
  });

  test('the catalog layout is written down once', () => {
    expect(catalogPath('en')).toBe('packages/i18n/catalogs/en.json');
  });
});
