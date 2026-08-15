import { beforeEach, describe, expect, test } from 'bun:test';
import { flattenCatalog } from './catalog';
import {
  currentLocale,
  localeCookieOf,
  registerCatalog,
  resetCatalogs,
  resolveLocale,
  t,
  useI18n,
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

  test('an explicit choice outranks the browser Accept-Language', () => {
    // The header is what the browser was installed as; the switcher cookie, the stored user
    // preference and `?locale=` are what a person chose. Ranking the header first meant a user
    // who picked Spanish got English on every request afterwards.
    expect(resolveLocale({ header: 'en-US,en;q=0.9', cookie: 'es' }, { supported })).toEqual({
      locale: 'es',
      direction: 'ltr',
      source: 'cookie',
    });
    expect(resolveLocale({ header: 'en-US,en;q=0.9', user: 'es' }, { supported })).toEqual({
      locale: 'es',
      direction: 'ltr',
      source: 'user',
    });
    expect(resolveLocale({ header: 'en-US,en;q=0.9', query: 'es' }, { supported })).toEqual({
      locale: 'es',
      direction: 'ltr',
      source: 'query',
    });
    // `?locale=` is per request, so it outranks the cookie the switcher wrote.
    expect(resolveLocale({ cookie: 'de', query: 'es' }, { supported })).toEqual({
      locale: 'es',
      direction: 'ltr',
      source: 'query',
    });
  });

  test('reads the locale cookie out of a raw Cookie header', () => {
    expect(localeCookieOf('sid=abc; x_locale=pt-BR; theme=dark')).toBe('pt-BR');
    expect(localeCookieOf('sid=abc')).toBeUndefined();
    expect(localeCookieOf(undefined)).toBeUndefined();
  });

  test('a cookie that will not decode is a value, never a URIError out of the request', () => {
    // `x_locale=%` threw straight out of a per-request path; the raw value simply fails to
    // normalise and the next source wins.
    expect(localeCookieOf('x_locale=%')).toBe('%');
    expect(localeCookieOf('sid=abc; x_locale=%E0%A4%A; theme=dark')).toBe('%E0%A4%A');
    expect(
      resolveLocale({ cookie: localeCookieOf('x_locale=%'), user: 'es' }, { supported }),
    ).toEqual({ locale: 'es', direction: 'ltr', source: 'user' });
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
    expect(useI18n()('errors.notFound.title')).toBe('Lost?');
  });
});
