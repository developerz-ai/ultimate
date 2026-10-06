// The one cookie header codec: `readCookie` reads a `Cookie:` request header, `serializeSetCookie`
// builds a `Set-Cookie` value. At tier 0 because three packages need it — auth and http at tier 2
// cannot import each other, i18n sits below both — and each copy had to rediscover the same thrown
// `URIError` on its own (`bun run flight-copies` refuses a fourth).

import { renderCauseValue } from './error-render';
import { UltimateError } from './errors';

/**
 * A `Cookie:` header is attacker-controlled, and `decodeURIComponent('%')` throws a bare
 * `URIError` — which escapes every coded path that reads through here: an OAuth callback would
 * answer 500 instead of `X_OAUTH_STATE_INVALID`, and `curl -H 'Cookie: x-locale=%'` paged the
 * on-call from the `locale` stage. The raw value is returned instead, so the caller's own
 * rejection stays the readable failure; a raw value is still checked against a signature, a stored
 * hash or a `supported` list, and none of them match a mangled one.
 */
const decodeCookieValue = (raw: string): string => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/**
 * The value of cookie `name` in a `Cookie:` header, or `null` when the header or the cookie is
 * absent. Never throws: the header is client-authored, so an unreadable value is the raw value and
 * a header that is not a string at all is no cookie.
 */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (typeof header !== 'string') return null;
  for (const part of header.split(';')) {
    const equals = part.indexOf('=');
    if (equals === -1) continue;
    if (part.slice(0, equals).trim() !== name) continue;
    return decodeCookieValue(part.slice(equals + 1).trim());
  }
  return null;
}

/** `SameSite`: `None` sends the cookie cross-site, so it is only accepted beside `Secure`. */
export type CookieSameSite = 'Strict' | 'Lax' | 'None';
/** Chromium's `Priority`, the order cookies are evicted in when a domain is over its quota. */
export type CookiePriority = 'Low' | 'Medium' | 'High';

export interface SetCookieOptions {
  /** Seconds until expiry; `0` clears the cookie. A non-negative integer. */
  readonly maxAge?: number;
  /** Absolute expiry, written as an IMF-fixdate in UTC. Beside `maxAge`, `maxAge` wins in a browser. */
  readonly expires?: Date;
  /** Defaults to `/`. Must start with `/`: a browser silently replaces any other with its own. */
  readonly path?: string;
  /** Omitted by default, which scopes the cookie to the exact host that set it. */
  readonly domain?: string;
  /** Defaults to `true`. */
  readonly secure?: boolean;
  /** Defaults to `true`. */
  readonly httpOnly?: boolean;
  /** Defaults to `'Lax'`. */
  readonly sameSite?: CookieSameSite;
  /** CHIPS: keyed to the top-level site. Requires `secure`. */
  readonly partitioned?: boolean;
  readonly priority?: CookiePriority;
}

/** RFC 6265 §4.1.1 `token`: any CHAR except CTLs and the separators `()<>@,;:\"/[]?={}`, SP, HT. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
/** Every UTF-16 unit outside RFC 6265 `cookie-octet` — plus `%`, which readCookie decodes. */
const NOT_COOKIE_OCTET = /[^\x21\x23\x24\x26-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]+/g;
/**
 * A lone UTF-16 surrogate: it has no UTF-8 form, so `encodeURIComponent` would throw a bare
 * `URIError`. Spelled out because `String#isWellFormed` is ES2024 and the lib is ES2023.
 */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** A path a browser keeps verbatim: absolute, printable ASCII, no `;` to end the attribute early. */
const COOKIE_PATH = /^\/[\x21-\x3A\x3C-\x7E]*$/;
const DOMAIN_LABEL = '[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?';
const COOKIE_DOMAIN = new RegExp(`^\\.?${DOMAIN_LABEL}(?:\\.${DOMAIN_LABEL})*$`);
/** RFC 6265bis §5.6/§5.7: a browser ignores a pair over 4096 octets and an attribute over 1024. */
const MAX_PAIR_OCTETS = 4096;
const MAX_ATTRIBUTE_OCTETS = 1024;
const SAME_SITE: readonly string[] = ['Strict', 'Lax', 'None'];
const PRIORITY: readonly string[] = ['Low', 'Medium', 'High'];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const PARTITIONED_FIX =
  'serializeSetCookie(name, value, { partitioned: true, secure: true })   # Partitioned requires Secure';

type CookieField = keyof SetCookieOptions | 'name' | 'value';

/** A `Set-Cookie` the caller asked for that a browser would drop, misread or let be injected into. */
export class CookieInvalidError extends UltimateError {
  override readonly name = 'CookieInvalidError';

  constructor(field: CookieField, cookie: string, reason: string, fix: string) {
    super({
      code: 'X_COOKIE_INVALID',
      cause: `Set-Cookie ${renderCauseValue(cookie)}: ${field} ${reason}`,
      fix,
      meta: { field },
    });
  }
}

/**
 * Percent-encodes exactly what `cookie-octet` excludes, and `%`. Minimal rather than
 * `encodeURIComponent`, so a base64url token or a sealed value is written byte-identical — moving
 * an existing cookie onto this does not change what a non-Ultimate reader sees — while
 * `decodeURIComponent` in `readCookie` still inverts it exactly: what was passed is what is read.
 */
const encodeCookieValue = (value: string): string =>
  value.replace(NOT_COOKIE_OCTET, (run) => encodeURIComponent(run));

const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * RFC 9110 §5.6.7 IMF-fixdate, read from the `getUTC*` fields: the zone is UTC by construction,
 * never the process's, and no locale table can rename a weekday.
 */
function imfFixdate(at: Date): string {
  const day = WEEKDAYS[at.getUTCDay()];
  const month = MONTHS[at.getUTCMonth()];
  const year = String(at.getUTCFullYear()).padStart(4, '0');
  const time = `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())}:${pad(at.getUTCSeconds())}`;
  return `${day}, ${pad(at.getUTCDate())} ${month} ${year} ${time} GMT`;
}

/**
 * RFC 6265bis §4.1.3: a browser drops a prefixed cookie that breaks its prefix's rule, silently,
 * and matches the prefix case-insensitively — so the refusal does too.
 */
function checkPrefix(name: string, secure: boolean, path: string, domain: string | undefined) {
  const lower = name.toLowerCase();
  if (lower.startsWith('__secure-') && !secure) {
    throw new CookieInvalidError(
      'name',
      name,
      'has the __Secure- prefix without Secure',
      'serializeSetCookie(name, value, { secure: true })   # __Secure- requires Secure',
    );
  }
  if (!lower.startsWith('__host-')) return;
  if (!secure || domain !== undefined || path !== '/') {
    throw new CookieInvalidError(
      'name',
      name,
      'has the __Host- prefix, which requires Secure, no Domain and Path=/',
      "serializeSetCookie(name, value, { secure: true, path: '/' })   # __Host- also forbids domain",
    );
  }
}

function checkAttribute(
  field: 'path' | 'domain',
  name: string,
  value: string,
  shape: RegExp,
  fix: string,
) {
  if (value.length <= MAX_ATTRIBUTE_OCTETS && shape.test(value)) return;
  throw new CookieInvalidError(
    field,
    name,
    `${renderCauseValue(value)} is not a valid ${field}`,
    fix,
  );
}

function checkEnum(
  field: 'sameSite' | 'priority',
  name: string,
  value: string,
  allowed: readonly string[],
) {
  if (allowed.includes(value)) return;
  const reason = `${renderCauseValue(value)} is not one of ${allowed.join(', ')}`;
  throw new CookieInvalidError(
    field,
    name,
    reason,
    `serializeSetCookie(name, value, { ${field}: '${allowed[1]}' })   # one of ${allowed.join(', ')}`,
  );
}

function expiresAttribute(name: string, expires: Date): string {
  const year = expires instanceof Date ? expires.getUTCFullYear() : Number.NaN;
  // Below 1601 a cookie parser rejects the date (RFC 6265 §5.1.1); above 9999 it is not 4 digits.
  if (!(year >= 1601 && year <= 9999)) {
    throw new CookieInvalidError(
      'expires',
      name,
      `${renderCauseValue(expires)} is not a Date between the years 1601 and 9999`,
      'serializeSetCookie(name, value, { expires: new Date(Date.now() + ms) })   # or maxAge in seconds',
    );
  }
  return `; Expires=${imfFixdate(expires)}`;
}

/**
 * One `Set-Cookie` header value — the only place the framework spells one. Defaults are the ones
 * `@ultimat3/auth`'s session and OAuth cookies already ship: `Path=/; HttpOnly; Secure;
 * SameSite=Lax`. The value is encoded so `readCookie` returns it exactly; anything a browser would
 * silently drop, or that could end the header early, is an `X_COOKIE_INVALID` instead.
 */
export function serializeSetCookie(
  name: string,
  value: string,
  options: SetCookieOptions = {},
): string {
  if (!COOKIE_NAME.test(name)) {
    const reason = "is not an RFC 6265 token (letters, digits and !#$%&'*+-.^_`|~ only)";
    throw new CookieInvalidError(
      'name',
      name,
      reason,
      "serializeSetCookie('session_id', value)   # letters, digits, - and _ only",
    );
  }
  if (LONE_SURROGATE.test(value)) {
    const fix =
      'serializeSetCookie(name, value.toWellFormed())   # or base64url-encode binary data';
    throw new CookieInvalidError('value', name, 'has a lone UTF-16 surrogate', fix);
  }
  const encoded = encodeCookieValue(value);
  if (name.length + encoded.length > MAX_PAIR_OCTETS) {
    const reason = `is ${encoded.length} octets encoded; a browser drops a cookie over ${MAX_PAIR_OCTETS}`;
    throw new CookieInvalidError(
      'value',
      name,
      reason,
      'serializeSetCookie(name, sessionId)   # keep the data server-side, an id in the cookie',
    );
  }
  const { maxAge, expires, domain, partitioned, priority } = options;
  const path = options.path ?? '/';
  const secure = options.secure ?? true;
  const httpOnly = options.httpOnly ?? true;
  const sameSite = options.sameSite ?? 'Lax';
  checkPrefix(name, secure, path, domain);
  checkEnum('sameSite', name, sameSite, SAME_SITE);
  if (sameSite === 'None' && !secure) {
    const reason = 'is None without Secure, which every current browser rejects';
    throw new CookieInvalidError(
      'sameSite',
      name,
      reason,
      "serializeSetCookie(name, value, { sameSite: 'None', secure: true })   # None requires Secure",
    );
  }
  if (partitioned === true && !secure) {
    const reason = 'is set without Secure, which a browser rejects';
    throw new CookieInvalidError('partitioned', name, reason, PARTITIONED_FIX);
  }
  let header = `${name}=${encoded}`;
  if (maxAge !== undefined) {
    if (!Number.isSafeInteger(maxAge) || maxAge < 0) {
      const reason = `${renderCauseValue(maxAge)} is not a whole number of seconds >= 0`;
      throw new CookieInvalidError(
        'maxAge',
        name,
        reason,
        'serializeSetCookie(name, value, { maxAge: Math.floor(ms / 1000) })   # 0 clears the cookie',
      );
    }
    header += `; Max-Age=${maxAge}`;
  }
  if (expires !== undefined) header += expiresAttribute(name, expires);
  if (domain !== undefined) {
    checkAttribute(
      'domain',
      name,
      domain,
      COOKIE_DOMAIN,
      "serializeSetCookie(name, value, { domain: 'example.com' })   # a bare host, or omit domain",
    );
    header += `; Domain=${domain}`;
  }
  checkAttribute(
    'path',
    name,
    path,
    COOKIE_PATH,
    "serializeSetCookie(name, value, { path: '/app' })   # absolute, percent-encoded",
  );
  header += `; Path=${path}`;
  if (httpOnly) header += '; HttpOnly';
  if (secure) header += '; Secure';
  header += `; SameSite=${sameSite}`;
  if (partitioned === true) header += '; Partitioned';
  if (priority !== undefined) {
    checkEnum('priority', name, priority, PRIORITY);
    header += `; Priority=${priority}`;
  }
  return header;
}
