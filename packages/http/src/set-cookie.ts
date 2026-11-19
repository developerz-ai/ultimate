// How a route handler, a page loader or an action sets a cookie on the response it cannot build:
// one serialized line, from core's one serializer, appended to the context's response-header bag —
// the bag the `response` stage APPENDS `set-cookie` from, so two cookies are two lines, never one.

import {
  CookieInvalidError,
  readCookie,
  type SetCookieOptions,
  serializeSetCookie,
} from '@ultimat3/core';
import { assertInRequest } from './context';

/**
 * What identifies the cookie being cleared, plus the attributes its prefix or partition requires.
 * A browser deletes only the cookie whose name, `Path` and `Domain` all match — `Partitioned` too
 * for a CHIPS cookie — so these must be what `setCookie` was given. No `maxAge`, `expires` or
 * `priority`: the clearing line decides those itself.
 */
export type DeleteCookieOptions = Pick<
  SetCookieOptions,
  'path' | 'domain' | 'secure' | 'httpOnly' | 'sameSite' | 'partitioned'
>;

const DELETE_FIX = 'deleteCookie(name, { path, domain })   # the one way to clear a cookie';

/**
 * Clearing has ONE spelling, `deleteCookie`, so a reader searching for where a cookie dies finds
 * every site. `maxAge: 0` and an `expires` already past both clear in a browser, so both are
 * refused here rather than left as a second, unsearchable way to do the same thing.
 */
function refuseClearing(name: string, options: SetCookieOptions, now: Date): void {
  if (options.maxAge === 0) {
    throw new CookieInvalidError('maxAge', name, 'is 0, which deletes the cookie', DELETE_FIX);
  }
  const { expires } = options;
  if (expires instanceof Date && expires.getTime() <= now.getTime()) {
    throw new CookieInvalidError(
      'expires',
      name,
      'is not after now, so it deletes the cookie',
      DELETE_FIX,
    );
  }
}

// A whole line is read back rather than parsed by a second grammar: it is accepted only if core's
// serializer writes exactly those bytes from what was read, so CR/LF, a stray attribute or a broken
// `__Host-` rule cannot reach the header bag.

interface CookieLine {
  readonly name: string;
  readonly value: string;
  readonly options: SetCookieOptions;
}

type ReadOptions = { -readonly [K in keyof SetCookieOptions]: SetCookieOptions[K] };

const SAME_SITE = ['Strict', 'Lax', 'None'] as const;
const PRIORITY = ['Low', 'Medium', 'High'] as const;

/**
 * Never names the line or anything cut from it: it may hold a live session token, and this message
 * reaches the log.
 */
const notSerialized = (): CookieInvalidError =>
  new CookieInvalidError(
    'value',
    'serialized line',
    'is not a line serializeSetCookie wrote',
    'setCookie(sessionCookie(token, policy))   # pass the line unchanged, or setCookie(name, value, options)',
  );

/** Attribute names are compared lowercased; the byte comparison is what holds their spelling. */
function readAttribute(options: ReadOptions, attribute: string): void {
  const equals = attribute.indexOf('=');
  const key = (equals === -1 ? attribute : attribute.slice(0, equals)).toLowerCase();
  const text = equals === -1 ? '' : attribute.slice(equals + 1);
  if (key === 'max-age') options.maxAge = Number(text);
  else if (key === 'expires') options.expires = new Date(text);
  else if (key === 'domain') options.domain = text;
  else if (key === 'path') options.path = text;
  else if (key === 'httponly') options.httpOnly = true;
  else if (key === 'secure') options.secure = true;
  else if (key === 'partitioned') options.partitioned = true;
  else if (key === 'samesite') {
    const sameSite = SAME_SITE.find((known) => known === text);
    if (sameSite !== undefined) options.sameSite = sameSite;
  } else if (key === 'priority') {
    const priority = PRIORITY.find((known) => known === text);
    if (priority !== undefined) options.priority = priority;
  }
}

/** The cookie `line` declares, or `X_COOKIE_INVALID` when the serializer would not write it so. */
function readCookieLine(line: string): CookieLine {
  if (typeof line !== 'string') throw notSerialized();
  const [pair = '', ...attributes] = line.split('; ');
  const equals = pair.indexOf('=');
  if (equals < 1) throw notSerialized();
  const name = pair.slice(0, equals);
  const value = readCookie(pair, name) ?? '';
  // An absent flag is false here, where the serializer's default is true: the line said so.
  const options: ReadOptions = { secure: false, httpOnly: false };
  for (const attribute of attributes) readAttribute(options, attribute);
  let written: string;
  try {
    written = serializeSetCookie(name, value, options);
  } catch (error) {
    // Its own message would echo the name, which on a malformed line can be anything.
    if (error instanceof CookieInvalidError) throw notSerialized();
    throw error;
  }
  if (written !== line) throw notSerialized();
  return { name, value, options };
}

/**
 * A line the serializer already built, unchanged: what `@ultimat3/auth` answers (`sessionCookie()`,
 * `login().cookie`) and cannot set itself, being http's tier-mate. A clearing line is refused like
 * any other clear, but a session line keeps its `Max-Age=0`: `updatePrivileges` writes one when the
 * rotated session has under a second left, and refusing it would fail the grant that just landed.
 */
function appendLine(ctx: ReturnType<typeof assertInRequest>, line: string): void {
  const cookie = readCookieLine(line);
  if (cookie.value === '' || cookie.options.maxAge !== 0) {
    refuseClearing(cookie.name, cookie.options, ctx.now());
  }
  ctx.headers.append('set-cookie', line);
}

/**
 * Put a cookie on the response to the request in scope, from a line `serializeSetCookie` built
 * (`setCookie(sessionCookie(token, policy))`), or by name, on core's defaults:
 * `Path=/; HttpOnly; Secure; SameSite=Lax`. Every call APPENDS a line — the same name on two
 * paths is two cookies — and an invalid cookie is `X_COOKIE_INVALID` before anything is appended.
 * Outside a request it throws `X_NO_REQUEST`: a cookie nobody will receive is a silent failure.
 */
export function setCookie(line: string): void;
export function setCookie(name: string, value: string, options?: SetCookieOptions): void;
export function setCookie(nameOrLine: string, value?: string, options: SetCookieOptions = {}) {
  const ctx = assertInRequest('setCookie()');
  if (value === undefined) {
    appendLine(ctx, nameOrLine);
    return;
  }
  refuseClearing(nameOrLine, options, ctx.now());
  ctx.headers.append('set-cookie', serializeSetCookie(nameOrLine, value, options));
}

/**
 * Clear cookie `name`: an empty value and `Max-Age=0`, with the `Path` and `Domain` it was set
 * with (defaults the same as `setCookie`'s, so a cookie set with none is cleared with none).
 */
export const deleteCookie = (name: string, options: DeleteCookieOptions = {}): void => {
  const ctx = assertInRequest('deleteCookie()');
  ctx.headers.append('set-cookie', serializeSetCookie(name, '', { ...options, maxAge: 0 }));
};
