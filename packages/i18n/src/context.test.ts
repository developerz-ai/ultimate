/**
 * Guards the locale-configuration RESET seam: `configureLocales` is process-global and merges, so
 * a wrong reset is a wrong `<html lang>` in every later file of the same `bun test` process.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createContext, MAX_CACHED_FORMATTERS, runWithContext } from '@ultimat3/core';
import { flattenCatalog } from './catalog';
import {
  configureLocales,
  currentDirection,
  currentLocale,
  localeConfig,
  localeCookieOf,
  registerCatalog,
  resetCatalogs,
  resetLocaleConfig,
  resolveLocale,
  t,
  translatorFor,
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

  test('takes an ABSENT source as `undefined`, the shape this package\u2019s own readers answer', () => {
    // `localeCookieOf` answers `string | undefined`, so this is the composition the package is
    // for. `LocaleSources` declared `?: string | null` under `exactOptionalPropertyTypes`, which
    // refuses an explicit `undefined` \u2014 the caller had to write `?? null` to satisfy a type
    // whose own reader skips `undefined` on the next line.
    expect(resolveLocale({ cookie: localeCookieOf(undefined), user: 'es' }, { supported })).toEqual(
      { locale: 'es', direction: 'ltr', source: 'user' },
    );
    expect(
      resolveLocale(
        { header: undefined, cookie: undefined, user: undefined, query: undefined },
        {
          supported,
          fallback: 'de',
        },
      ),
    ).toEqual({ locale: 'de', direction: 'ltr', source: 'default' });
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

/**
 * The declaration is the boundary. `resolveLocale` can only ever answer with a member of
 * `supported` or the fallback, so a tag the app DECLARES is the one route by which a value
 * `Intl` cannot parse reaches `ctx.locale` — and from there `formatDate`, `formatMoney` and
 * `Intl.PluralRules`, one request at a time, several frames from `app.config.ts`.
 */
describe('configureLocales screens what it is handed', () => {
  afterEach(() => {
    resetLocaleConfig();
  });

  test('a supported tag Intl cannot parse is refused at boot, naming the tag', () => {
    // Lowercase, because `normalizeLocale` lowercases before it compares — `e` is exactly the
    // shape that survives every later check and lands on a formatter.
    expect(() => configureLocales({ supported: ['en', 'e'] })).toThrow(/X_LOCALE_INVALID/);
    expect(() => configureLocales({ supported: ['en', 'e'] })).toThrow(/"e"/);
    // Refused means unchanged: a rejected call must not leave half a config behind.
    expect(localeConfig().supported).toEqual([...SUPPORTED_LOCALES]);
  });

  test('a fallback that is not a tag is refused too', () => {
    expect(() => configureLocales({ fallback: 'en_US' })).toThrow(/X_LOCALE_INVALID/);
    expect(localeConfig().fallback).toBe(DEFAULT_LOCALE);
  });

  test('every tag the framework itself ships passes, script subtags included', () => {
    expect(() =>
      configureLocales({ supported: [...SUPPORTED_LOCALES, 'zh-hant', 'pt-br'] }),
    ).not.toThrow();
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

describe('currentDirection', () => {
  afterEach(() => {
    resetLocaleConfig();
  });

  test('is the direction of the locale the context carries, normalised first', () => {
    configureLocales({ supported: ['en', 'ar', 'he'], fallback: 'en' });
    runWithContext(createContext({ locale: 'ar-EG' }), () => {
      expect(currentLocale()).toBe('ar');
      expect(currentDirection()).toBe('rtl');
    });
    runWithContext(createContext({ locale: 'he' }), () => {
      expect(currentDirection()).toBe('rtl');
    });
    runWithContext(createContext({ locale: 'en-GB' }), () => {
      expect(currentDirection()).toBe('ltr');
    });
  });

  test('a locale outside the supported set takes the fallback’s direction, not its own', () => {
    // `fa` is RTL, but an app that does not support it renders the fallback — and `dir` must
    // agree with the copy that is actually on the page.
    configureLocales({ supported: ['en'], fallback: 'en' });
    runWithContext(createContext({ locale: 'fa-IR' }), () => {
      expect(currentLocale()).toBe('en');
      expect(currentDirection()).toBe('ltr');
    });
    configureLocales({ supported: ['ar'], fallback: 'ar' });
    runWithContext(createContext({ locale: 'kl-GL' }), () => {
      expect(currentDirection()).toBe('rtl');
    });
  });

  test('outside any context it is the configured fallback’s direction', () => {
    configureLocales({ supported: ['en', 'he'], fallback: 'he' });
    expect(currentDirection()).toBe('rtl');
  });
});

describe('the translator cache', () => {
  test('is bounded — the oldest locale is evicted, not kept for the life of the process', () => {
    // `translatorFor` is exported raw and `packages/mail/src/render.ts` passes it a value nothing
    // normalised, so the key is a REQUEST value. Keyed raw into an unbounded `Map`, 5,000
    // distinct-but-valid tags through this function and `pluralCategory` retained +79.9 MB after
    // `Bun.gc(true)` — memory the client chooses. A rebuild is a new function object, which is
    // what makes the eviction observable: first key in, first key out.
    const oldest = translatorFor('en-x-oldest');
    for (let index = 0; index < MAX_CACHED_FORMATTERS; index += 1) {
      translatorFor(`en-x-a${index}`);
    }
    expect(translatorFor('en-x-oldest')).not.toBe(oldest);
  });

  test('a locale still inside the cap is answered from the cache, never rebuilt', () => {
    // The bound must not become "no cache at all": building a translator per render is the waste
    // the memo exists to avoid.
    const warm = translatorFor('en-x-warm');
    expect(translatorFor('en-x-warm')).toBe(warm);
  });

  test('two spellings of one locale share ONE entry', () => {
    // Canonicalised, so the cap counts LOCALES rather than the spellings a header chose.
    expect(translatorFor('en-us')).toBe(translatorFor('en-US'));
  });

  test('a catalog registered as `en-US` answers `en-us`, whichever spelling reads FIRST', () => {
    // The order-dependent half of the same key. `translatorFor('en-us')` matched neither
    // `registry.has('en-us')` nor `catalogFor('en-us')`, so it cached an EMPTY translator under
    // the canonical key — and the later `translatorFor('en-US')`, whose catalog was right there,
    // was served that same empty translator from the cache. Whether an app's strings rendered
    // depended on which spelling a request carried first, which is not a property a catalog has.
    registerCatalog('en-US', flattenCatalog({ nav: { home: 'Home' } }));
    expect(translatorFor('en-us')('nav.home')).toBe('Home');
    expect(translatorFor('en-US')('nav.home')).toBe('Home');
    resetCatalogs();
  });

  test('every tag that is not a locale shares ONE entry, so junk cannot fill the cap', () => {
    // The bound is on a map a REQUEST value keys into: `translatorFor` is exported raw and
    // `packages/mail/src/render.ts` hands it an unnormalised value. Keyed on the raw tag, a
    // malformed `Accept-Language` took a slot each and evicted locales that were real — a bounded
    // cache a client can still flush. Nothing is registered under any of them, so one entry is
    // all they were ever worth.
    const warm = translatorFor('en-x-junk-warm');
    for (let index = 0; index < MAX_CACHED_FORMATTERS; index += 1) {
      translatorFor(`junk_${index} tag`);
    }
    expect(translatorFor('en-x-junk-warm')).toBe(warm);
  });

  test('a REGISTERED tag ICU will not canonicalise still keys on itself', () => {
    // The exception the collapse must not swallow: `en_US` is not a structurally valid tag, so
    // `canonicalLocale` refuses it — but an app that registered it asked for that catalog by name,
    // and answering it from the shared junk entry would hand back the empty one.
    registerCatalog('en_US', flattenCatalog({ nav: { home: 'Underscored' } }));
    expect(translatorFor('en_US')('nav.home')).toBe('Underscored');
    expect(translatorFor('also not a tag')('nav.home')).toBe('⟦nav.home⟧');
    resetCatalogs();
  });

  test('a registration evicts the entry a request built, under the SAME key it cached', () => {
    // `en-US` is the case that separates the two: the cache key is `en-us`, so a `delete(locale)`
    // on the caller's own spelling misses it and the next reader is served the catalog that was
    // replaced — a stale string for the life of the process.
    registerCatalog('en-US', flattenCatalog({ nav: { home: 'Home' } }));
    expect(translatorFor('en-US')('nav.home')).toBe('Home');
    registerCatalog('en-US', flattenCatalog({ nav: { home: 'Start' } }));
    expect(translatorFor('en-US')('nav.home')).toBe('Start');
    resetCatalogs();
  });
});
