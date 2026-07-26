import { beforeEach, describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import {
  currentLocale,
  currentTranslator,
  localeCookieOf,
  registerCatalog,
  resetCatalogs,
  resolveLocale,
  t,
} from './context';

const supported = ['en', 'es', 'de'] as const;

describe('resolveLocale', () => {
  test('negotiates from the Accept-Language header', () => {
    const resolved = resolveLocale(
      { header: 'de-DE,de;q=0.9,en;q=0.7' },
      { supported, fallback: 'en' },
    );
    expect(resolved).toEqual({ locale: 'de', direction: 'ltr', source: 'header' });
  });

  test('skips a source that resolves to nothing instead of failing the request', () => {
    // A stale cookie for a locale the app dropped must not 500 the page.
    const resolved = resolveLocale(
      { header: null, cookie: 'kl', user: 'es' },
      { supported, fallback: 'en' },
    );
    expect(resolved).toEqual({ locale: 'es', direction: 'ltr', source: 'user' });
  });

  test('falls back to the default and reports the source', () => {
    expect(resolveLocale({}, { supported, fallback: 'en' })).toEqual({
      locale: 'en',
      direction: 'ltr',
      source: 'default',
    });
  });

  test('marks RTL locales', () => {
    const resolved = resolveLocale({ user: 'ar-EG' }, { supported: ['en', 'ar'], fallback: 'en' });
    expect(resolved).toEqual({ locale: 'ar', direction: 'rtl', source: 'user' });
  });

  test('reads the locale cookie out of a raw Cookie header', () => {
    expect(localeCookieOf('sid=abc; x_locale=pt-BR; theme=dark')).toBe('pt-BR');
    expect(localeCookieOf('sid=abc')).toBeUndefined();
    expect(localeCookieOf(undefined)).toBeUndefined();
  });
});

describe('ambient translator', () => {
  beforeEach(() => {
    resetCatalogs();
  });

  test('t() resolves through the registered catalog for the current locale', () => {
    registerCatalog('en', flattenCatalog({ nav: { home: 'Home' } }));
    expect(currentLocale()).toBe('en');
    expect(t('nav.home')).toBe('Home');
    expect(t('nav.missing')).toBe('⟦nav.missing⟧');
  });

  test('app catalogs registered later override framework strings', () => {
    registerCatalog('en', flattenCatalog({ errors: { notFound: { title: 'Page not found' } } }));
    registerCatalog('en', flattenCatalog({ errors: { notFound: { title: 'Lost?' } } }));
    expect(currentTranslator()('errors.notFound.title')).toBe('Lost?');
  });
});
