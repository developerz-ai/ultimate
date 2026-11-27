// The design system's strings, resolved on the server and read back in an island: every `ui.*` key
// crosses, in the request's locale, and the island's translator answers what the server's would.

import { describe, expect, test } from 'bun:test';
import {
  catalogTranslator,
  FRAMEWORK_CATALOGS,
  flattenCatalog,
  registerCatalog,
  resetCatalogs,
  translatorFor,
} from '@ultimat3/i18n';
import { subsetTranslator } from '@ultimat3/i18n/subset';
import { UI_KEYS } from './i18n-keys';
import { uiCatalog } from './ui-catalog';

describe('uiCatalog', () => {
  test('carries every ui key the catalog holds, and nothing outside the namespace', () => {
    const catalog = Object.fromEntries(Object.values(UI_KEYS).map((key) => [key, `es:${key}`]));
    const t = catalogTranslator({ ...catalog, 'app.title': 'Postly' }, 'es');
    const subset = uiCatalog(t);
    expect(subset.locale).toBe('es');
    expect(Object.keys(subset.catalog).sort()).toEqual(Object.values(UI_KEYS).sort());
    const island = subsetTranslator(JSON.parse(JSON.stringify(subset)));
    expect(island(UI_KEYS.retry)).toBe('es:ui.retry');
    expect(island('app.title')).toBe('⟦app.title⟧');
  });

  // Every `ui.*` key the design system reads is shipped in every framework locale, so an island in
  // a ro, es or pt-BR app is never handed English or a `⟦ui.*⟧` it cannot recover from.
  test('every ui key is translated in every locale the framework ships', () => {
    for (const [locale, catalog] of Object.entries(FRAMEWORK_CATALOGS)) {
      const missing = Object.values(UI_KEYS).filter((key) => !Object.hasOwn(catalog, key));
      expect(`${locale}: ${missing.join(', ')}`).toBe(`${locale}: `);
    }
  });

  test("a ro app's island carries the Romanian strings", () => {
    try {
      registerCatalog('ro', flattenCatalog({ app: { title: 'Postly' } }));
      const island = subsetTranslator(uiCatalog(translatorFor('ro')));
      expect(island(UI_KEYS.dismiss)).toBe('Închide');
      expect(island(UI_KEYS.close)).toBe('Închide');
    } finally {
      resetCatalogs();
    }
  });
});
