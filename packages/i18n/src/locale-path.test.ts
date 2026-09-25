// The URL half of a locale: which prefixes route, how one is split off, and how a path is spelled.
import { afterEach, describe, expect, test } from 'bun:test';
import { configureLocales, resetLocaleConfig, routedLocales } from './context';
import { localizedPath, splitLocalePrefix, unlocalizedPath } from './locale-path';

afterEach(() => resetLocaleConfig());

describe('routedLocales', () => {
  test('an app that declared no locales routes only its fallback — never the thirty shipped tags', () => {
    expect(routedLocales()).toEqual(['en']);
  });

  test('a declared set routes, the default first', () => {
    configureLocales({ supported: ['en', 'es-co'], fallback: 'es-co' });
    expect(routedLocales()).toEqual(['es-co', 'en']);
  });
});

describe('splitLocalePrefix', () => {
  const locales = ['es-co', 'en', 'pt-BR'];

  test('a segment naming no routed locale is no prefix', () => {
    expect(splitLocalePrefix('/fr/x', locales, 'es-co')).toBeUndefined();
    expect(splitLocalePrefix('/english/x', locales, 'es-co')).toBeUndefined();
    expect(splitLocalePrefix('/', locales, 'es-co')).toBeUndefined();
  });

  test('an uppercase spelling is not a second URL for the same page', () => {
    expect(splitLocalePrefix('/EN/x', locales, 'es-co')).toBeUndefined();
  });

  test('the default locale is flagged, so the caller can redirect the duplicate', () => {
    expect(splitLocalePrefix('/es-co/precios', locales, 'es-co')).toEqual({
      locale: 'es-co',
      path: '/precios',
      isDefault: true,
    });
  });

  test('a routed locale is split off, answered in its registered spelling', () => {
    expect(splitLocalePrefix('/en/precios', locales, 'es-co')).toEqual({
      locale: 'en',
      path: '/precios',
      isDefault: false,
    });
    expect(splitLocalePrefix('/pt-br', locales, 'es-co')?.locale).toBe('pt-BR');
    expect(splitLocalePrefix('/en', locales, 'es-co')?.path).toBe('/');
    expect(splitLocalePrefix('/en/', locales, 'es-co')?.path).toBe('/');
  });
});

describe('localizedPath', () => {
  test('the default locale is the unprefixed path', () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(localizedPath('/precios', 'es-co')).toBe('/precios');
    expect(localizedPath('/en/precios', 'es-co')).toBe('/precios');
  });

  test('another locale is prefixed; the root is the directory form', () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(localizedPath('/precios', 'en')).toBe('/en/precios');
    expect(localizedPath('/', 'en')).toBe('/en/');
    expect(localizedPath('/en/precios', 'en')).toBe('/en/precios');
  });

  test('a query and a fragment are kept', () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(localizedPath('/precios?plan=pro#faq', 'en')).toBe('/en/precios?plan=pro#faq');
  });

  test('unlocalizedPath is the path the route table matches', () => {
    configureLocales({ supported: ['es-co', 'en'], fallback: 'es-co' });
    expect(unlocalizedPath('/en/precios')).toBe('/precios');
    expect(unlocalizedPath('/precios')).toBe('/precios');
  });
});
