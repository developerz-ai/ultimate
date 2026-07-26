/**
 * Locale resolution only: the supported set, the default, tag normalization and
 * HTTP `Accept-Language` negotiation. Knows nothing about catalogs or interpolation.
 */

import { localeUnsupported } from './errors';

/** A normalized BCP-47 tag — primary subtag, lowercase (`pt`), or `lang-script` (`zh-hant`). */
export type Locale = string;

export const DEFAULT_LOCALE: Locale = 'en';

/** Locales the framework's own catalogs may ship for. Apps narrow or extend this set. */
export const SUPPORTED_LOCALES: readonly Locale[] = [
  'en',
  'es',
  'pt',
  'fr',
  'de',
  'it',
  'nl',
  'pl',
  'ru',
  'uk',
  'tr',
  'cs',
  'sv',
  'da',
  'nb',
  'fi',
  'el',
  'ro',
  'hu',
  'ar',
  'he',
  'fa',
  'ur',
  'hi',
  'id',
  'vi',
  'th',
  'ja',
  'ko',
  'zh',
];

/**
 * Right-to-left scripts, by primary subtag. A static CLDR-derived set rather than
 * `Intl.Locale.prototype.getTextInfo` so direction is deterministic across runtimes.
 */
const RTL_LOCALES: ReadonlySet<string> = new Set([
  'ar',
  'arc',
  'ckb',
  'dv',
  'fa',
  'he',
  'ks',
  'ku',
  'nqo',
  'ps',
  'sd',
  'ug',
  'ur',
  'yi',
]);

export type Direction = 'ltr' | 'rtl';

/**
 * Strip region, lowercase, fall back to the default.
 * `pt-BR` → `pt`; `ZH-Hant-TW` → `zh-hant` when that tag is supported, else `zh`.
 */
export function normalizeLocale(
  tag?: string | null,
  supported: readonly Locale[] = SUPPORTED_LOCALES,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  if (!tag) return fallback;
  const lower = tag.trim().toLowerCase().replace(/_/g, '-');
  if (lower.length === 0 || lower === '*') return fallback;
  if (supported.includes(lower)) return lower;

  const segments = lower.split('-');
  const primary = segments[0] ?? '';
  // `lang-script` is a distinct written form (zh-hant vs zh-hans) — try it before dropping to `lang`.
  const script = segments[1];
  if (script !== undefined && script.length === 4) {
    const withScript = `${primary}-${script}`;
    if (supported.includes(withScript)) return withScript;
  }
  return supported.includes(primary) ? primary : fallback;
}

/** Same as `normalizeLocale` but loud: use where an unknown locale is a caller bug. */
export function assertSupportedLocale(
  tag: string,
  supported: readonly Locale[] = SUPPORTED_LOCALES,
): Locale {
  const normalized = normalizeLocale(tag, supported, '');
  if (normalized === '') throw localeUnsupported(tag, supported);
  return normalized;
}

export function isSupportedLocale(
  tag: string,
  supported: readonly Locale[] = SUPPORTED_LOCALES,
): boolean {
  return normalizeLocale(tag, supported, '') !== '';
}

export interface LanguageRange {
  tag: string;
  quality: number;
}

/**
 * Parse `Accept-Language: en-GB,en;q=0.9,fr-CH;q=0.8,*;q=0.5` into ranges sorted by
 * quality descending, ties resolved by header order (stable sort).
 */
export function parseAcceptLanguage(header?: string | null): LanguageRange[] {
  if (!header) return [];
  const ranges: LanguageRange[] = [];
  for (const part of header.split(',')) {
    const [rawTag, ...params] = part.trim().split(';');
    const tag = rawTag?.trim();
    if (!tag) continue;
    let quality = 1;
    for (const param of params) {
      const match = /^\s*q\s*=\s*([0-9.]+)\s*$/i.exec(param);
      if (match?.[1] !== undefined) {
        const parsed = Number.parseFloat(match[1]);
        quality = Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 1) : 0;
      }
    }
    if (quality > 0) ranges.push({ tag: tag.toLowerCase(), quality });
  }
  return ranges.sort((a, b) => b.quality - a.quality);
}

/**
 * Pick the best supported locale for an `Accept-Language` header.
 * `*` matches the fallback rather than the first supported locale — a wildcard is
 * "no preference", not "any language you have".
 */
export function negotiateLocale(
  acceptLanguage?: string | null,
  supported: readonly Locale[] = SUPPORTED_LOCALES,
  fallback: Locale = DEFAULT_LOCALE,
): Locale {
  for (const { tag } of parseAcceptLanguage(acceptLanguage)) {
    if (tag === '*') return fallback;
    const match = normalizeLocale(tag, supported, '');
    if (match !== '') return match;
  }
  return fallback;
}

export function isRtl(locale: Locale): boolean {
  const primary = locale.split('-')[0]?.toLowerCase() ?? '';
  return RTL_LOCALES.has(primary);
}

export function directionOf(locale: Locale): Direction {
  return isRtl(locale) ? 'rtl' : 'ltr';
}
