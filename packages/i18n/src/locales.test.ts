import { describe, expect, test } from 'bun:test';
import {
  assertSupportedLocale,
  directionOf,
  isRtl,
  isSupportedLocale,
  negotiateLocale,
  normalizeLocale,
  parseAcceptLanguage,
  SUPPORTED_LOCALES,
} from './locales';

const supported = ['en', 'es', 'pt', 'de', 'ar', 'zh-hant', 'zh'] as const;

describe('normalizeLocale', () => {
  test('strips region and lowercases', () => {
    expect(normalizeLocale('pt-BR', supported)).toBe('pt');
    expect(normalizeLocale('ES', supported)).toBe('es');
    expect(normalizeLocale('de_AT', supported)).toBe('de');
  });

  test('keeps a supported script subtag before dropping to the primary tag', () => {
    expect(normalizeLocale('zh-Hant-TW', supported)).toBe('zh-hant');
    expect(normalizeLocale('zh-Hans-CN', supported)).toBe('zh');
  });

  test('falls back for unknown, empty and wildcard tags', () => {
    expect(normalizeLocale('kl-GL', supported)).toBe('en');
    expect(normalizeLocale(undefined, supported)).toBe('en');
    expect(normalizeLocale('*', supported)).toBe('en');
  });
});

describe('negotiateLocale', () => {
  test('honours q-values from a real Accept-Language header', () => {
    // Chrome-shaped header: the highest q wins even when it is not first.
    const header = 'fr-CH;q=0.4,en;q=0.5,de-DE;q=0.9,de;q=0.8,*;q=0.1';
    expect(negotiateLocale(header, supported)).toBe('de');
  });

  test('skips unsupported languages and picks the best supported one', () => {
    expect(negotiateLocale('kl,is;q=0.9,pt-BR;q=0.5', supported)).toBe('pt');
  });

  test('treats a bare wildcard as no preference', () => {
    expect(negotiateLocale('*', supported, 'es')).toBe('es');
    expect(negotiateLocale('', supported, 'es')).toBe('es');
  });

  test('drops q=0 ranges', () => {
    expect(parseAcceptLanguage('de;q=0,es;q=0.3').map((range) => range.tag)).toEqual(['es']);
    expect(negotiateLocale('de;q=0,es;q=0.3', supported)).toBe('es');
  });
});

describe('direction', () => {
  test('detects RTL by primary subtag', () => {
    expect(isRtl('ar')).toBe(true);
    expect(isRtl('he-IL')).toBe(true);
    expect(isRtl('fa')).toBe(true);
    expect(isRtl('en')).toBe(false);
    expect(directionOf('ur-PK')).toBe('rtl');
    expect(directionOf('de')).toBe('ltr');
  });
});

describe('assertSupportedLocale', () => {
  test('answers the NORMALIZED tag, not the one the caller passed', () => {
    expect(assertSupportedLocale('pt-BR', supported)).toBe('pt');
    expect(assertSupportedLocale('ES', supported)).toBe('es');
    expect(assertSupportedLocale('zh-Hant-TW', supported)).toBe('zh-hant');
  });

  test('an unsupported tag throws X_LOCALE_UNSUPPORTED instead of falling back to en', () => {
    // The whole difference from `normalizeLocale`: `en` is IN `supported`, so a shared fallback
    // would make every unknown tag look like a successful resolution.
    expect(normalizeLocale('kl-GL', supported)).toBe('en');
    expect(codeOf(() => assertSupportedLocale('kl-GL', supported))).toBe('X_LOCALE_UNSUPPORTED');
    expect(causeOf(() => assertSupportedLocale('kl-GL', supported))).toContain('kl-GL');
    // An empty tag is unsupported too — `normalizeLocale` returns the fallback for it.
    expect(codeOf(() => assertSupportedLocale('', supported))).toBe('X_LOCALE_UNSUPPORTED');
  });

  test('defaults to the shipped supported set when none is passed', () => {
    expect(assertSupportedLocale('de-DE')).toBe('de');
    expect(SUPPORTED_LOCALES).toContain('de');
    expect(codeOf(() => assertSupportedLocale('kl-GL'))).toBe('X_LOCALE_UNSUPPORTED');
  });
});

describe('isSupportedLocale', () => {
  test('is the same question without the throw', () => {
    expect(isSupportedLocale('pt-BR', supported)).toBe(true);
    expect(isSupportedLocale('zh-Hant-TW', supported)).toBe(true);
    expect(isSupportedLocale('kl-GL', supported)).toBe(false);
    expect(isSupportedLocale('', supported)).toBe(false);
    // Narrowing the set is what makes a previously-supported tag false.
    expect(isSupportedLocale('de', ['en'])).toBe(false);
    expect(isSupportedLocale('de-AT')).toBe(true);
  });
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { code?: unknown }).code);
  }
  return 'no-throw';
}

function causeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return String((error as { cause?: unknown }).cause);
  }
  return 'no-throw';
}
