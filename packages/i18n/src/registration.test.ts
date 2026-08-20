// The question `x i18n check` never asked, and issue #249 shipped through: are the catalogs this
// app ships actually IN the registry the running app reads? A catalog file on disk, a
// `defineCatalogs()` call in a module, and a green audit of one against the other are three facts
// that say nothing about whether anything ever imported that module.

import { afterEach, describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import { registerCatalog, resetCatalogs, resetLocaleConfig } from './context';
import { defineCatalogs } from './define-catalogs';
import { I18nError } from './errors';
import { assertCatalogsRegistered, catalogRegistrationGaps } from './registration';

const shipped = {
  en: flattenCatalog({ app: { play: { title: 'Play' } }, site: { home: { title: 'Home' } } }),
  es: flattenCatalog({ app: { play: { title: 'Jugar' } }, site: { home: { title: 'Inicio' } } }),
};

afterEach(() => {
  resetCatalogs();
  // `defineCatalogs` narrows the supported set process-wide; only this puts it back.
  resetLocaleConfig();
});

describe('catalogRegistrationGaps', () => {
  test('reports every shipped key when nothing imported the module that registers them', () => {
    const gaps = catalogRegistrationGaps(shipped);

    expect(gaps.map((gap) => gap.locale)).toEqual(['en', 'es']);
    expect(gaps[0]?.missing).toEqual(['app.play.title', 'site.home.title']);
    expect(gaps[0]?.shipped).toBe(2);
  });

  test('is empty when defineCatalogs ran — a correctly wired app is never a finding', () => {
    defineCatalogs({
      default: 'en',
      locales: {
        en: { app: { play: { title: 'Play' } }, site: { home: { title: 'Home' } } },
        es: { app: { play: { title: 'Jugar' } }, site: { home: { title: 'Inicio' } } },
      },
    });

    expect(catalogRegistrationGaps(shipped)).toEqual([]);
  });

  test('reports the ONE locale that did not reach the registry, not the whole set', () => {
    registerCatalog('en', shipped.en);

    const gaps = catalogRegistrationGaps(shipped);

    expect(gaps.map((gap) => gap.locale)).toEqual(['es']);
  });

  test('a key the runtime holds under a DIFFERENT locale is still a gap', () => {
    registerCatalog('en', shipped.es);

    // `es` is registered nowhere: a per-locale registry is the only thing that can answer this,
    // and a set-of-all-keys check would have called this app wired.
    expect(catalogRegistrationGaps({ es: shipped.es }).map((gap) => gap.locale)).toEqual(['es']);
  });
});

describe('assertCatalogsRegistered', () => {
  test('throws X_CATALOG_UNREGISTERED naming the locale, the count and the first keys', () => {
    let thrown: unknown;
    try {
      assertCatalogsRegistered(shipped);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(I18nError);
    const error = thrown as I18nError;
    expect(error.code).toBe('X_CATALOG_UNREGISTERED');
    expect(error.cause).toContain('en');
    expect(error.cause).toContain('app.play.title');
    expect(error.fix).toContain('defineCatalogs');
  });

  test('is silent for a registered app', () => {
    registerCatalog('en', shipped.en);
    registerCatalog('es', shipped.es);

    expect(() => assertCatalogsRegistered(shipped)).not.toThrow();
  });
});
