// WHERE the request's locale and zone are read from — the header and cookie NAMES, and nothing
// else. What a locale or a zone IS belongs to `@ultimat3/i18n` and `@ultimat3/time` (tier 1, a
// legal downward import), which is why this file negotiates nothing: three re-implementations
// lived here and all three disagreed with their owner about the same request.

import { LOCALE_COOKIE } from '@ultimat3/i18n';
import { TIMEZONE_HEADER } from '@ultimat3/time';

export interface LocaleConfig {
  /** Cookie the client sets when the user picks a locale explicitly. */
  readonly cookie: string;
}

export interface TimeZoneConfig {
  /** Header the client sets from `Intl.DateTimeFormat().resolvedOptions().timeZone`. */
  readonly header: string;
  readonly cookie: string;
}

/**
 * The supported set and the fallback are NOT here: `defineCatalogs()` already declares them, and
 * a second copy in this config meant an app shipping `{ en, fr }` still resolved `ctx.locale` to
 * `'en'` forever. The cookie name is `@ultimat3/i18n`'s own constant for the same reason — a
 * language switcher written against the documented `LOCALE_COOKIE` was read by nothing.
 */
export const DEFAULT_LOCALE_CONFIG: LocaleConfig = {
  cookie: LOCALE_COOKIE,
};

/** The default zone is `configureTime({ defaultZone })`'s, so a process has one answer, not two. */
export const DEFAULT_TZ_CONFIG: TimeZoneConfig = {
  header: TIMEZONE_HEADER,
  cookie: 'x_timezone',
};

/**
 * The raw value on a malformed escape, never a throw. `Cookie:` is attacker-controlled and
 * `decodeURIComponent('%')` is a bare `URIError` — thrown from the `locale` stage, which runs on
 * every request, so `curl -H 'Cookie: x-locale=%'` answered 500 and paged the on-call. Nothing is
 * loosened: a locale that is not in `supported` still falls back, and a time zone `Intl` cannot
 * format is still refused. `@ultimat3/auth` guards its own cookie reader the same way and for the
 * same reason; the guard is four lines and this package can never import that one (same tier).
 */
const decodeCookieValue = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

export const readCookie = (header: string | null, name: string): string | null => {
  if (header === null) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeCookieValue(part.slice(index + 1).trim());
  }
  return null;
};
