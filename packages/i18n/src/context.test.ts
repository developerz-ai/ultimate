/**
 * Guards the locale-configuration RESET seam: `configureLocales` is process-global and merges, so
 * a wrong reset is a wrong `<html lang>` in every later file of the same `bun test` process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { flattenCatalog } from './catalog';
import {
  configureLocales,
  currentLocale,
  localeConfig,
  localeCookieOf,
  registerCatalog,
  resetCatalogs,
  resetLocaleConfig,
  resolveLocale,
  t,
  useI18n,
} from './context';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from './locales';

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

describe('currentLocale', () => {
  afterEach(() => {
    resetLocaleConfig();
    resetCatalogs();
  });

  // `Ctx.locale` is a plain string core never validates, and it reaches `translatorFor` and
  // `Intl.PluralRules` through two module-level maps that are never swept. Unnormalised, every
  // distinct spelling a request carried bought a permanent `Translator` and a permanent
  // `PluralRules` — an unbounded cache keyed by user input, on the ambient read path.
  test('normalises the ambient locale, the same call `resolveLocale` makes for its sources', () => {
    runWithContext(createContext({ locale: 'pt-BR' }), () => {
      expect(currentLocale()).toBe('pt');
    });
  });

  test('an unsupported tag falls back instead of becoming a cache key of its own', () => {
    configureLocales({ supported: ['en', 'es'], fallback: 'es' });
    runWithContext(createContext({ locale: 'zz-ZZ' }), () => {
      expect(currentLocale()).toBe('es');
    });
  });

  test('two spellings of one locale share ONE memoized translator', () => {
    const first = runWithContext(createContext({ locale: 'en-US' }), () => useI18n());
    const second = runWithContext(createContext({ locale: 'EN-gb' }), () => useI18n());

    expect(second).toBe(first);
    expect(first.locale).toBe('en');
  });
});

describe('resetLocaleConfig', () => {
  afterEach(() => {
    resetLocaleConfig();
  });

  // The leak this exists to close: `defineCatalogs()` runs at an APP's module scope, so one test
  // that loads an app narrows `supported` for every later file of the same `bun test` process —
  // and `<html lang>` answers `en` to `Accept-Language: de-DE` in a file that never mentioned
  // locales. `configureLocales` merges, so no partial call can widen the set back.
  test('puts the shipped supported set back, which a partial configureLocales cannot', () => {
    configureLocales({ supported: ['en'], fallback: 'en' });
    expect(localeConfig().supported).toEqual(['en']);

    resetLocaleConfig();

    expect(localeConfig().supported).toEqual(SUPPORTED_LOCALES);
    expect(localeConfig().fallback).toBe(DEFAULT_LOCALE);
  });

  // The documented behaviour the leak was corrupting, asserted on its own: with `de` registered,
  // a `de-DE` header negotiates `de`. Read through the ambient config — no `overrides` argument —
  // because the overrides argument is exactly what hides a corrupted module-level config.
  test('a de-DE header negotiates de again once the narrowing is undone', () => {
    configureLocales({ supported: ['en'], fallback: 'en' });
    expect(resolveLocale({ header: 'de-DE,de;q=0.9,en;q=0.7' }).locale).toBe('en');

    resetLocaleConfig();

    expect(resolveLocale({ header: 'de-DE,de;q=0.9,en;q=0.7' })).toEqual({
      locale: 'de',
      direction: 'ltr',
      source: 'header',
    });
  });

  // A "default" shared by reference is not a default. `localeConfig()` hands out the LIVE object,
  // and that object used to BE `DEFAULT_LOCALE_CONFIG` — so one caller writing through it corrupted
  // the value the reset restores FROM, and every later reset replayed the corruption.
  test('a caller that mutates the live config cannot corrupt what the reset restores', () => {
    const shipped = [...SUPPORTED_LOCALES];
    expect(shipped.length).toBeGreaterThan(1);

    // The cast is the point: a `readonly` annotation stops a compiler, not the JS caller this
    // seam exists for.
    const live = localeConfig() as unknown as {
      supported: string[];
      fallback: string;
      order: string[];
    };
    live.supported.length = 0;
    live.order.length = 0;
    live.fallback = 'zz';

    resetLocaleConfig();

    expect(localeConfig().supported).toEqual(shipped);
    expect(localeConfig().fallback).toBe(DEFAULT_LOCALE);
    // The arrays too, and `SUPPORTED_LOCALES` is a module export half the framework reads.
    expect(SUPPORTED_LOCALES).toEqual(shipped);
    // Precedence back as behaviour, not only as a field.
    expect(resolveLocale({ header: 'en-US,en;q=0.9', cookie: 'es' }).source).toBe('cookie');
  });

  test('the source precedence is restored too, not only the supported set', () => {
    configureLocales({ order: ['header'] });
    expect(resolveLocale({ header: 'en-US,en;q=0.9', cookie: 'es' }).source).toBe('header');

    resetLocaleConfig();

    expect(resolveLocale({ header: 'en-US,en;q=0.9', cookie: 'es' }).source).toBe('cookie');
  });
});
