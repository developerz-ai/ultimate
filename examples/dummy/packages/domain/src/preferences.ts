/**
 * The closed sets a member may choose from. Closed because the settings page renders them and
 * `x verify` checks that every locale here has a complete catalog.
 */

export const SUPPORTED_LOCALES = ['en', 'es'] as const;

export type AppLocale = (typeof SUPPORTED_LOCALES)[number];

/**
 * IANA zones offered in settings. Deliberately a short curated list rather than the full tzdb:
 * every entry is covered by the digest scheduling tests, including both DST hemispheres and one
 * zone with no DST at all.
 */
export const SUPPORTED_ZONES = [
  'UTC',
  'America/New_York',
  'America/Sao_Paulo',
  'Europe/Madrid',
  'Europe/Berlin',
  'Asia/Tokyo',
  'Australia/Sydney',
  'Pacific/Auckland',
] as const;

export type AppZone = (typeof SUPPORTED_ZONES)[number];

/** `system` follows `prefers-color-scheme`; the other two are an explicit override. */
export const THEMES = ['system', 'light', 'dark'] as const;

export type AppTheme = (typeof THEMES)[number];

export const DEFAULT_LOCALE: AppLocale = 'en';
export const DEFAULT_ZONE: AppZone = 'UTC';
export const DEFAULT_THEME: AppTheme = 'system';

/** The hour, in the member's own zone, at which the nightly digest is delivered. */
export const DIGEST_LOCAL_HOUR = 9;

export const isSupportedLocale = (value: string): value is AppLocale =>
  (SUPPORTED_LOCALES as readonly string[]).includes(value);

export const isSupportedZone = (value: string): value is AppZone =>
  (SUPPORTED_ZONES as readonly string[]).includes(value);
