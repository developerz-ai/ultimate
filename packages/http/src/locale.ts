// Locale and time zone are resolved once per request, before any handler runs, so
// no code path can format a date or a number without them. `@ultimat3/i18n` owns
// catalogs; this file only owns the negotiation of the two request-scoped values.

export interface LocaleConfig {
  readonly supported: readonly string[];
  readonly default: string;
  /** Cookie the client sets when the user picks a locale explicitly. */
  readonly cookie: string;
}

export interface TimeZoneConfig {
  readonly default: string;
  /** Header the client sets from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  readonly header: string;
  readonly cookie: string;
}

export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  supported: ['en'],
  default: 'en',
  cookie: 'x-locale',
};

export const DEFAULT_TZ_CONFIG: TimeZoneConfig = {
  default: 'UTC',
  header: 'x-timezone',
  cookie: 'x-timezone',
};

export const readCookie = (header: string | null, name: string): string | null => {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
};

interface Weighted {
  readonly tag: string;
  readonly q: number;
}

const parseAcceptLanguage = (header: string): readonly Weighted[] =>
  header
    .split(',')
    .map((entry): Weighted => {
      const [tag = '', ...params] = entry.trim().split(';');
      const qParam = params.find((p) => p.trim().startsWith('q='));
      const q = qParam === undefined ? 1 : Number.parseFloat(qParam.trim().slice(2));
      return { tag: tag.trim().toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((entry) => entry.tag.length > 0 && entry.q > 0)
    .sort((a, b) => b.q - a.q);

/**
 * Exact match wins, then primary-subtag match (`de-CH` -> `de`), then the config
 * default. `*` is treated as "no preference" rather than "any locale" so the
 * default stays predictable for SEO and cache keys.
 */
export const negotiateLocale = (
  acceptLanguage: string | null,
  config: LocaleConfig = DEFAULT_LOCALE_CONFIG,
  explicit?: string | null,
): string => {
  const supported = config.supported.map((locale) => locale.toLowerCase());
  const pick = (candidate: string): string | undefined => {
    const wanted = candidate.toLowerCase();
    const exact = supported.indexOf(wanted);
    if (exact !== -1) return config.supported[exact];
    const primary = wanted.split('-')[0] ?? wanted;
    const loose = supported.findIndex((locale) => (locale.split('-')[0] ?? locale) === primary);
    return loose === -1 ? undefined : config.supported[loose];
  };

  if (explicit !== undefined && explicit !== null) {
    const chosen = pick(explicit);
    if (chosen !== undefined) return chosen;
  }
  if (acceptLanguage !== null) {
    for (const entry of parseAcceptLanguage(acceptLanguage)) {
      if (entry.tag === '*') break;
      const chosen = pick(entry.tag);
      if (chosen !== undefined) return chosen;
    }
  }
  return config.default;
};

/** A time zone is only accepted if `Intl` can actually format with it. */
export const isValidTimeZone = (candidate: string): boolean => {
  try {
    new Intl.DateTimeFormat('en', { timeZone: candidate }).format(0);
    return true;
  } catch {
    return false;
  }
};

export const resolveTimeZone = (
  candidate: string | null,
  config: TimeZoneConfig = DEFAULT_TZ_CONFIG,
): string => {
  if (candidate !== null && candidate.length > 0 && isValidTimeZone(candidate)) return candidate;
  return config.default;
};
