// The design system's strings, resolved on the server and read back in an island: every `ui.*` key
// crosses, in the request's locale, and the island's translator answers what the server's would.

import { describe, expect, test } from 'bun:test';
import { catalogTranslator } from '@ultimat3/i18n';
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
});
