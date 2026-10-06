// How a route handler, a page loader or an action sets a cookie on the response it cannot build:
// one serialized line, from core's one serializer, appended to the context's response-header bag —
// the bag the `response` stage APPENDS `set-cookie` from, so two cookies are two lines, never one.

import { CookieInvalidError, type SetCookieOptions, serializeSetCookie } from '@ultimat3/core';
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

/**
 * Set cookie `name` on the response to the request in scope. Defaults are core's:
 * `Path=/; HttpOnly; Secure; SameSite=Lax`. Every call APPENDS a line — the same name on two
 * paths is two cookies — and an invalid cookie is `X_COOKIE_INVALID` before anything is appended.
 * Outside a request it throws `X_NO_REQUEST`: a cookie nobody will receive is a silent failure.
 */
export const setCookie = (name: string, value: string, options: SetCookieOptions = {}): void => {
  const ctx = assertInRequest('setCookie()');
  refuseClearing(name, options, ctx.now());
  ctx.headers.append('set-cookie', serializeSetCookie(name, value, options));
};

/**
 * Clear cookie `name`: an empty value and `Max-Age=0`, with the `Path` and `Domain` it was set
 * with (defaults the same as `setCookie`'s, so a cookie set with none is cleared with none).
 */
export const deleteCookie = (name: string, options: DeleteCookieOptions = {}): void => {
  const ctx = assertInRequest('deleteCookie()');
  ctx.headers.append('set-cookie', serializeSetCookie(name, '', { ...options, maxAge: 0 }));
};
