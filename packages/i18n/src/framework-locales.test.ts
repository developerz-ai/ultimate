// The framework's own strings in every locale it ships: each catalog answers every `en` key with
// the same placeholders, and an app's catalog in that language — any spelling of it — stands on
// it, its own strings on top. A shipped language the app never registered stays out of the app.

import { afterEach, describe, expect, test } from 'bun:test';
import { DEFAULT_LOCALE } from '@ultimat3/core';
import { flattenCatalog } from './catalog';
import { registerCatalog, registeredLocales, resetCatalogs, translatorFor } from './context';
import { FRAMEWORK_CATALOG, FRAMEWORK_CATALOGS } from './framework';
import { isMiss } from './translator';

afterEach(() => {
  resetCatalogs();
});

const SHIPPED = Object.keys(FRAMEWORK_CATALOGS).filter((locale) => locale !== DEFAULT_LOCALE);
const PLURAL_SUFFIX = /_(zero|one|two|few|many|other|plural)$/;
const placeholders = (template: string): string[] =>
  [...template.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();

describe('every shipped locale is complete', () => {
  test('ships ro, es and pt-BR beside en', () => {
    expect(Object.keys(FRAMEWORK_CATALOGS).sort()).toEqual(['en', 'es', 'pt-BR', 'ro']);
  });

  for (const locale of SHIPPED) {
    const catalog = FRAMEWORK_CATALOGS[locale] ?? {};

    test(`${locale} answers every en key, with a real string`, () => {
      const missing = Object.keys(FRAMEWORK_CATALOG).filter(
        (key) => !Object.hasOwn(catalog, key) || (catalog[key] ?? '').trim() === '',
      );
      expect(missing).toEqual([]);
    });

    test(`${locale} adds no key en lacks, except a plural form of an en plural`, () => {
      const stems = new Set(
        Object.keys(FRAMEWORK_CATALOG)
          .filter((key) => key.endsWith('_plural'))
          .map((key) => key.replace(PLURAL_SUFFIX, '')),
      );
      const extra = Object.keys(catalog).filter(
        (key) =>
          !Object.hasOwn(FRAMEWORK_CATALOG, key) && !stems.has(key.replace(PLURAL_SUFFIX, '')),
      );
      expect(extra).toEqual([]);
    });

    test(`${locale} keeps every placeholder its en string has, and invents none`, () => {
      const drift = Object.entries(catalog).flatMap(([key, template]) => {
        const source = FRAMEWORK_CATALOG[key] ?? FRAMEWORK_CATALOG[key.replace(PLURAL_SUFFIX, '')];
        const want = placeholders(source ?? '');
        const got = placeholders(template);
        return want.join(',') === got.join(',') ? [] : [`${key}: ${got} != ${want}`];
      });
      expect(drift).toEqual([]);
    });
  }
});

describe("an app's locale picks the shipped strings up", () => {
  test('a ro app renders the design system in Romanian, its own strings on top', () => {
    registerCatalog('ro', flattenCatalog({ ui: { close: 'Închide fereastra' }, app: { a: 'A' } }));
    const t = translatorFor('ro');
    expect(t('ui.dismiss')).toBe('Închide');
    expect(t('ui.close')).toBe('Închide fereastra');
    expect(t('app.a')).toBe('A');
  });

  test('pt-br stands on pt-BR, and es-MX on es', () => {
    registerCatalog('pt-br', flattenCatalog({ app: { a: 'A' } }));
    registerCatalog('es-MX', flattenCatalog({ app: { a: 'A' } }));
    expect(translatorFor('pt-br')('ui.dismiss')).toBe('Dispensar');
    expect(translatorFor('es-MX')('ui.dismiss')).toBe('Descartar');
  });

  test('Romanian plurals take few and the "de" form', () => {
    registerCatalog('ro', flattenCatalog({ app: { a: 'A' } }));
    const t = translatorFor('ro');
    expect(t('pagination.result', { count: 1 })).toBe('1 rezultat');
    expect(t('pagination.result', { count: 3 })).toBe('3 rezultate');
    expect(t('pagination.result', { count: 20 })).toBe('20 de rezultate');
  });

  test('a shipped language the app never registered is not one the app serves', () => {
    expect(registeredLocales()).toEqual([DEFAULT_LOCALE]);
    expect(isMiss(translatorFor('ro')('ui.dismiss'))).toBe(true);
  });
});
