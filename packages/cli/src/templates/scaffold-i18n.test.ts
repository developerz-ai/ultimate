import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import { i18nFiles, i18nIndex } from './scaffold-i18n';

describe('unit · the generated app catalog index', () => {
  test('one locale renders the shape x new has always scaffolded', () => {
    const source = i18nIndex(['en']);
    expect(source).toContain("import en from '../catalogs/en.json';");
    expect(source).toContain('locales: { en } });');
    expect(source).toContain('export type AppCatalog = typeof en;');
  });

  test('every locale on disk is imported and registered, not just the ones a run asked for', () => {
    const source = i18nIndex(['en', 'es']);
    expect(source).toContain("import en from '../catalogs/en.json';");
    expect(source).toContain("import es from '../catalogs/es.json';");
    expect(source).toContain('locales: { en, es }');
  });

  test('a locale tag that is not a valid JS identifier gets a camelCase binding and a quoted key', () => {
    const source = i18nIndex(['en', 'zh-hant']);
    // The import path names the real file on disk — the locale tag, not the binding.
    expect(source).toContain("import zhHant from '../catalogs/zh-hant.json';");
    // `defineCatalogs` resolves the locale from the object key, so the tag has to survive quoted.
    expect(source).toContain("locales: { en, 'zh-hant': zhHant }");
  });

  test('en is always registered and always first, even if the caller omits or reorders it', () => {
    // `default: 'en'` a few lines below requires `en` to be a registered locale — dropping it (a
    // caller passing only the locales a scan happened to find, say) would emit a file that fails
    // its own typecheck, so the template guarantees it rather than trusting every call site to.
    expect(i18nIndex(['es'])).toContain('locales: { en, es }');
    expect(i18nIndex(['es', 'en'])).toContain('locales: { en, es }');
  });

  test('locales are ordered deterministically so a diff shows only the locale a run actually added', () => {
    expect(i18nIndex(['es', 'fr', 'en'])).toContain('locales: { en, es, fr }');
    expect(i18nIndex(['fr', 'es'])).toContain('locales: { en, es, fr }');
  });

  test('the emitted module is parseable TypeScript for one locale or several', () => {
    for (const locales of [['en'], ['en', 'es'], ['en', 'zh-hant']]) {
      expect(() =>
        new Bun.Transpiler({ loader: 'ts' }).transformSync(i18nIndex(locales)),
      ).not.toThrow();
    }
  });

  test('i18nFiles still scaffolds the single-locale shape at x new time', () => {
    const files = i18nFiles(names('demo'), '1.0.0');
    const index = files.find((file) => file.path === 'packages/i18n/src/index.ts');
    expect(index?.contents).toBe(i18nIndex(['en']));
  });
});
