// `defineCatalogs` is the app's one registration call and it runs once, at boot — so a regression
// here is not a failing render but a locale that registered with no strings, or with half of them.
// These tests hold that line: all-or-nothing registration across every locale, and the app winning
// over the framework on a shared key.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import {
  configureLocales,
  localeConfig,
  registeredLocales,
  resetCatalogs,
  translatorFor,
} from './context';
import { defineCatalogs } from './define-catalogs';
import { I18nError } from './errors';
import { FRAMEWORK_CATALOG } from './framework';

const en = {
  nav: { home: 'Home', settings: 'Settings' },
  errors: { notFound: { title: 'Nothing here' } },
  files: { n_one: '{count} file', n_other: '{count} files' },
};

const es = {
  nav: { home: 'Inicio', settings: 'Ajustes' },
  errors: { notFound: { title: 'No hay nada' } },
  files: { n_one: '{count} archivo', n_other: '{count} archivos' },
};

/** `configureLocales` is process-global; snapshot it before any test moves it. */
const initialConfig = localeConfig();

/** Returns the X_* code a call throws, or `undefined` when it does not throw. */
function codeOf(run: () => unknown): string | undefined {
  try {
    run();
    return undefined;
  } catch (error) {
    return error instanceof I18nError ? error.code : undefined;
  }
}

beforeEach(() => {
  resetCatalogs();
  configureLocales(initialConfig);
});

afterAll(() => {
  resetCatalogs();
  configureLocales(initialConfig);
});

describe('defineCatalogs', () => {
  test('registers a catalog for every locale it is given', () => {
    const set = defineCatalogs({ default: 'en', locales: { en, es } });

    expect(registeredLocales()).toEqual(['en', 'es']);
    expect(set.locales).toEqual(['en', 'es']);
    expect(set.default).toBe('en');
    expect(translatorFor('en')('nav.home')).toBe('Home');
    expect(translatorFor('es')('nav.home')).toBe('Inicio');
  });

  test('registers framework strings under the app, so an app key of the same name wins', () => {
    // The framework ships this key; the fixture above deliberately redefines it.
    expect(FRAMEWORK_CATALOG['errors.notFound.title']).toBe('Page not found');

    defineCatalogs({ default: 'en', locales: { en, es } });
    const t = translatorFor('en');

    expect(t('errors.notFound.title')).toBe('Nothing here');
    // A framework key the app never mentions is still there — the app did not replace the catalog.
    expect(t('common.save')).toBe('Save');
  });

  test('configures the supported set and the fallback from the same call', () => {
    defineCatalogs({ default: 'es', locales: { en, es } });

    expect(localeConfig().supported).toEqual(['en', 'es']);
    expect(localeConfig().fallback).toBe('es');
  });

  test('flattens nested authoring to dot-keys and reports the key space', () => {
    const set = defineCatalogs({ default: 'en', locales: { en, es } });

    expect(set.catalogs.en['nav.home']).toBe('Home');
    expect(set.catalogs.es['errors.notFound.title']).toBe('No hay nada');
    expect(set.keys()).toEqual([
      'errors.notFound.title',
      'files.n_one',
      'files.n_other',
      'nav.home',
      'nav.settings',
    ]);
    // App keys only — the framework's own strings are registered, never copied into the set.
    expect(set.keys()).not.toContain('common.save');
  });

  test('refuses a default that is not one of the locales, and registers nothing', () => {
    const code = codeOf(() =>
      // @ts-expect-error — the same mistake is a compile error before it is a runtime one
      defineCatalogs({ default: 'fr', locales: { en, es } }),
    );

    expect(code).toBe('X_LOCALE_UNSUPPORTED');
    expect(registeredLocales()).toEqual([]);
  });

  test('rejects a non-string leaf with X_CATALOG_INVALID before registering any locale', () => {
    const code = codeOf(() =>
      defineCatalogs({ default: 'en', locales: { en, es: { nav: { home: ['Inicio'] } } } }),
    );

    expect(code).toBe('X_CATALOG_INVALID');
    // `en` is loadable and comes first: a half-registered app is what the two-pass load prevents.
    expect(registeredLocales()).toEqual([]);
  });

  test('plural families survive the round trip', () => {
    defineCatalogs({ default: 'en', locales: { en, es } });

    expect(translatorFor('en')('files.n', { count: 1 })).toBe('1 file');
    expect(translatorFor('es')('files.n', { count: 4 })).toBe('4 archivos');
  });
});
