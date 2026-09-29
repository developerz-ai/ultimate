// `x shot --cookie name=value[,name=value]` — cookies set in the browser before the first
// navigation, so a page is photographed with a cookie-held choice (consent, a dismissed banner)
// already made. Read here, before anything boots; scoped to the app's own origin once it exists.

import type { ShotCookie } from './browser-launcher-port';
import { BadFlagError } from './errors';

/** RFC 6265 `token` for a name; a value may not carry what ends or splits a Cookie header. */
const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const COOKIE_VALUE = /^[^\s;,"\\]*$/;

const FIX = 'x shot / --cookie consent=granted --json';

export interface ShotCookiePair {
  readonly name: string;
  readonly value: string;
}

const refuse = (reason: string): never => {
  throw new BadFlagError({ flag: 'cookie', command: 'shot', reason, fix: FIX });
};

/** The pairs `--cookie` names, in order; absent or empty is none. */
export function readCookieFlag(raw: string | undefined): readonly ShotCookiePair[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((pair) => {
      const at = pair.indexOf('=');
      if (at < 0) return refuse(`"${pair}" has no "=" — a cookie is name=value`);
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1).trim();
      if (!COOKIE_NAME.test(name)) return refuse(`"${name}" is not a cookie name`);
      if (!COOKIE_VALUE.test(value)) {
        return refuse(`the value of "${name}" holds a space, ";", ",", a quote or a backslash`);
      }
      return { name, value };
    });
}

/** Each pair for the app under test: the server's own URL, so no cookie reaches another host. */
export const shotCookies = (pairs: readonly ShotCookiePair[], url: string): readonly ShotCookie[] =>
  pairs.map((pair) => ({ ...pair, url }));
