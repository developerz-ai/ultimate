// Single responsibility: find every URL's userinfo in a string and hand it to a renderer — the one
// rule the redactors share. A URL parser ends the userinfo at the LAST `@` before the authority's
// end, so a password holding a raw `@` (`u:hunter@2secret@host`) is cut whole, never at its first.

import { REDACTED } from './secret';

/**
 * An authority: after `//`, up to the first `/`, `?` or `#` (WHATWG's end), or anything prose ends
 * a URL with — whitespace, a quote, a bracket. Greedy, so the last `@` inside it is the parser's.
 */
const AUTHORITY = /\/\/([^\s"'`<>()/?#]*)/g;

/**
 * Every `//userinfo@host` in `text` rewritten as `//render(userinfo)@host`; a URL with no `@` in
 * its authority, and an `@` past the path, query or fragment, are left as written. The renderer
 * decides how much survives: the user alone, a marker, nothing.
 */
export function replaceUrlUserinfo(text: string, render: (userinfo: string) => string): string {
  return text.replace(AUTHORITY, (whole: string, authority: string) => {
    const at = authority.lastIndexOf('@');
    return at < 0 ? whole : `//${render(authority.slice(0, at))}${authority.slice(at)}`;
  });
}

/**
 * `scheme://user:password@host` → `scheme://user:[redacted]@host`, for every URL in `text`. The
 * user stays — it is no secret — and the password runs to the userinfo's LAST `@`, raw `@` and `:`
 * included. What `x config` and `maskedEnvValues` print.
 */
export const redactUrlPassword = (text: string): string =>
  replaceUrlUserinfo(text, (userinfo) => {
    const colon = userinfo.indexOf(':');
    return colon < 0 ? userinfo : `${userinfo.slice(0, colon)}:${REDACTED}`;
  });
