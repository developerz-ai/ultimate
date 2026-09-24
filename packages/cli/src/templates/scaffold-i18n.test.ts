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

  // Row p: `en` was FORCED into every index, so an app whose catalogs hold no `en.json` got an
  // import of a file it does not have. `en` leads when it is there; otherwise the first tag does.
  test('en is first when the app has it, and never imported when it does not', () => {
    expect(i18nIndex(['es', 'en'])).toContain('locales: { en, es }');
    expect(i18nIndex(['es'])).toContain("defineCatalogs({ default: 'es', locales: { es } })");
    expect(i18nIndex(['es'])).not.toContain('en.json');
  });

  test('locales are ordered deterministically so a diff shows only the locale a run actually added', () => {
    expect(i18nIndex(['es', 'fr', 'en'])).toContain('locales: { en, es, fr }');
    expect(i18nIndex(['fr', 'es', 'en'])).toContain('locales: { en, es, fr }');
  });

  test('the emitted module is parseable TypeScript for one locale or several', () => {
    for (const locales of [['en'], ['en', 'es'], ['en', 'zh-hant']]) {
      expect(() =>
        new Bun.Transpiler({ loader: 'ts' }).transformSync(i18nIndex(locales)),
      ).not.toThrow();
    }
  });

  test('the catalog carries every key the shell, the hero and both dashboards read', () => {
    const files = i18nFiles(names('demo'), '1.0.0');
    const catalog = files.find((file) => file.path === 'packages/i18n/catalogs/en.json');
    const parsed = JSON.parse(String(catalog?.contents)) as Record<string, Record<string, unknown>>;
    const family = (name: string, child: string): Record<string, unknown> =>
      (parsed[name]?.[child] ?? {}) as Record<string, unknown>;
    // One key per family is enough to prove the family landed; the emitted i18n gate proves the rest.
    expect(parsed['shell']?.['brand']).toBe('Demo');
    expect(parsed['shell']?.['footer']).toBeDefined();
    expect(family('site', 'home')['headline']).toBeDefined();
    expect(family('site', 'home')['f3Body']).toBeDefined();
    const dashboard = family('app', 'dashboard');
    // Both shapes read the same file: the example's chart keys and the bare app's route keys.
    expect(dashboard['chartLabel']).toBeDefined();
    expect(dashboard['columnRender']).toBeDefined();
  });

  test('i18nFiles still scaffolds the single-locale shape at x new time', () => {
    const files = i18nFiles(names('demo'), '1.0.0');
    const index = files.find((file) => file.path === 'packages/i18n/src/index.ts');
    expect(index?.contents).toBe(i18nIndex(['en']));
  });
});
