// `registerFrameworkCatalog` is documented idempotent and it is exported, so it can be called a
// second time by boot code that has no way to know an app already registered. These tests pin the
// two halves that made that documentation false: a second call must not revert an app's override
// of a framework key, and the English catalog must reach the locale it is written in and no other.

import { afterEach, describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import { catalogFor, registerCatalog, resetCatalogs, translatorFor } from './context';
import { FRAMEWORK_CATALOG_LOCALE, registerFrameworkCatalog } from './framework';
import { isMiss } from './translator';

const appOverride = flattenCatalog({ errors: { notFound: { title: 'Nothing here' } } });

afterEach(() => {
  resetCatalogs();
});

describe('registerFrameworkCatalog', () => {
  test('a second call cannot revert an app override of a framework key', () => {
    registerFrameworkCatalog();
    registerCatalog('en', appOverride);
    expect(translatorFor('en')('errors.notFound.title')).toBe('Nothing here');

    // `registerCatalog` merges `existing` first and the argument second, so re-registering the
    // framework catalog put the English string back on top of every key an app had overridden.
    registerFrameworkCatalog();

    expect(translatorFor('en')('errors.notFound.title')).toBe('Nothing here');
  });

  test('registers under the locale the catalog is WRITTEN in, and misses loudly elsewhere', () => {
    registerFrameworkCatalog();
    // @ts-expect-error — the same mistake is a compile error before it is a runtime one: this
    // catalog is English, and filling `es` with English is the fallback chain `⟦key⟧` refuses.
    registerFrameworkCatalog('es');

    expect(isMiss(translatorFor('es')('common.save'))).toBe(true);
    expect(catalogFor('es')).toEqual({});
  });

  test('is idempotent on a fresh locale: one call and ten leave the same catalog', () => {
    registerFrameworkCatalog();
    const afterOne = { ...catalogFor(FRAMEWORK_CATALOG_LOCALE) };
    registerFrameworkCatalog();

    expect({ ...catalogFor(FRAMEWORK_CATALOG_LOCALE) }).toEqual(afterOne);
    expect(translatorFor('en')('common.save')).toBe('Save');
  });
});
