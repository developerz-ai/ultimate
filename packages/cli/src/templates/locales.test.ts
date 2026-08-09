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

  test('resolving an already-resolved list is a no-op, so call sites may chain', () => {
    expect(resolveLocales(resolveLocales(['EN', 'es']))).toEqual(['en', 'es']);
  });

  test('the catalog layout is written down once', () => {
    expect(catalogPath('en', 'invoice')).toBe('packages/i18n/catalogs/en/invoice.json');
  });
});
