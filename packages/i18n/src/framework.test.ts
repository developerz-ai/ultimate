// The framework's own strings must be in the registry in ANY process that can call `t()` — they
// are not an app's to register, and until 5.1.0 they were: `registerFrameworkCatalog()` had one
// caller, `defineCatalogs`, so an app whose catalog module nothing imported served
// `⟦errors.notFound.title⟧` on its 404 page (issue #249). These tests pin that, plus the two
// halves that must survive it: an app override is never reverted, and the English catalog reaches
// the locale it is written in and no other.

import { afterEach, describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import {
  catalogFor,
  registerBaseCatalog,
  registerCatalog,
  resetCatalogs,
  t,
  translatorFor,
} from './context';
import { FRAMEWORK_CATALOG_LOCALE } from './framework';
import { isMiss } from './translator';

const appOverride = flattenCatalog({ errors: { notFound: { title: 'Nothing here' } } });

afterEach(() => {
  resetCatalogs();
});

describe('the framework catalog is not an app responsibility', () => {
  test('framework strings resolve in a process that never called defineCatalogs', () => {
    expect(translatorFor(FRAMEWORK_CATALOG_LOCALE)('errors.notFound.title')).toBe('Page not found');
    expect(t('common.save')).toBe('Save');
  });

  test('resetCatalogs drops what an app registered and keeps what the framework ships', () => {
    registerCatalog('en', flattenCatalog({ app: { home: { title: 'Home' } } }));
    expect(translatorFor('en')('app.home.title')).toBe('Home');

    resetCatalogs();

    expect(isMiss(translatorFor('en')('app.home.title'))).toBe(true);
    expect(translatorFor('en')('common.save')).toBe('Save');
  });

  test('an app override of a framework key survives every later reinstall', () => {
    registerCatalog('en', appOverride);
    expect(translatorFor('en')('errors.notFound.title')).toBe('Nothing here');

    // `registerCatalog` merges `existing` first and the argument second, so seeding the base layer
    // into a locale an app has already registered would put the English string back on top of
    // every key that app overrode. `installBase` skips a locale that has anything in it.
    registerCatalog('en', flattenCatalog({ app: { second: 'Second' } }));

    expect(translatorFor('en')('errors.notFound.title')).toBe('Nothing here');
  });

  test('lands under the locale the catalog is WRITTEN in, and misses loudly elsewhere', () => {
    expect(isMiss(translatorFor('es')('common.save'))).toBe(true);
    expect(catalogFor('es')).toEqual({});
  });

  // Last in the file deliberately: `base` has no reset seam — that is the point of it — so the key
  // this test adds outlives the test, and `probe.only` is one nothing else here asserts about.
  test('a base layer installed AFTER an app catalog lands under it, never over it', () => {
    registerCatalog('en', appOverride);

    registerBaseCatalog(
      'en',
      flattenCatalog({
        probe: { only: 'Probe' },
        errors: { notFound: { title: 'Page not found' } },
      }),
    );

    // The late arrival is readable, and the app still owns the key it overrode.
    expect(translatorFor('en')('probe.only')).toBe('Probe');
    expect(translatorFor('en')('errors.notFound.title')).toBe('Nothing here');
  });
});
