#!/usr/bin/env bun
// Enforce, as a build error, that a `Set-Cookie` line is spelled in ONE place: core's
// `serializeSetCookie` in `packages/core/src/cookie.ts`, which `@ultimat3/http`'s `setCookie` /
// `deleteCookie` call. A hand-built line is where a cookie quietly loses `Secure`, a clearing line
// stops matching the `Path` it was set with and leaves a live twin, or a value carrying `;` ends the
// header early — auth spelled its four by hand until plan 101 sweep 10b.
//
// WHAT IT REPORTS, in shipped source and both tracked apps (tests are fixtures, never reported): a
// string or template literal that IS a cookie attribute (`'HttpOnly'`, `'path=/'`, `` `Max-Age=${s}` ``
// — as an array of parts is joined; flags and `Max-Age` in canonical case only), or that carries
// one after a `;` (`'sid=1; Path=/'`, any case, as a browser reads it). Prose naming an attribute,
// a `cache-control`/HSTS `max-age=`, and the serializer's options object are never reported.
//
// And, since plan 101 sweep 11, the header NAME — a `'set-cookie'` literal (any case) used as a
// headers key, an `.append(`/`.set(` argument or a `[name, value]` tuple head — outside the two
// seams that write it (`COOKIE_SEAM`, `HEADER_SEAM`). A line with no attribute carries nothing the
// attribute scan reads (`headers: { 'set-cookie': `sid=${t}` }` slipped), and the name is the one
// thing it cannot avoid writing. Reading, comparing or redacting the name is not writing one.
//
// A file not yet migrated is PINNED at its count with the sentence saying why (`SET_COOKIE_PINS`):
// it may fall, never rise, and a pin above the tree is stale. A file that relays a value the
// serializer built onto a header bag it owns is pinned apart (`SET_COOKIE_RELAY_PINS`), so a relay
// cannot be traded for a hand-spelled attribute in the same file.
//
//   bun run set-cookie-literals  ·  bun run scripts/set-cookie-literals.ts [--json]

import {
  endOfLiteral,
  maskLiterals,
  QUOTES,
  stripComments,
} from '../packages/core/src/source-mask';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'set-cookie-literals';
const THIS_FILE = 'scripts/set-cookie-literals.ts';

/** The one module that may spell a `Set-Cookie` line. */
export const COOKIE_SEAM = 'packages/core/src/cookie.ts';

/** `@ultimat3/http`'s `setCookie`/`deleteCookie`: the one module that appends the header by name. */
export const HEADER_SEAM = 'packages/http/src/set-cookie.ts';

export interface SetCookiePin {
  /** How many hand-spelled attribute literals the file may still hold. */
  readonly sites: number;
  /** Why it is not migrated yet, and who owns the migration. */
  readonly why: string;
}

/**
 * Files not yet migrated, each with the sentence saying why. Empty: auth and both tracked apps
 * write through `setCookie`/`deleteCookie` or `serializeSetCookie` (plan 101 sweep 10b). A new
 * entry is a waiver, and the guard's own test reads every one.
 */
export const SET_COOKIE_PINS: Readonly<Record<string, SetCookiePin>> = {};

/**
 * Files that write the header NAME to relay a line `serializeSetCookie` built, each with its count.
 * `@ultimat3/auth` is tier 2 beside `@ultimat3/http`, so it cannot call `setCookie` and must put
 * its own serializer-built lines on the `Headers` it returns. May fall, never rise.
 */
export const SET_COOKIE_RELAY_PINS: Readonly<Record<string, SetCookiePin>> = {
  'packages/auth/src/oauth-route.ts': {
    sites: 4,
    why: 'appends handshakeCookie(), clearHandshakeCookie() and sessionCookie() output — each a serializeSetCookie line in oauth-cookie.ts / session.ts — onto the redirect and problem Responses this route builds itself',
  },
  'packages/auth/src/sign-out.ts': {
    sites: 1,
    why: "signOutHeaders() returns a ['set-cookie', clearSessionCookie()] tuple for the caller to append; clearSessionCookie is serializeSetCookie with maxAge: 0",
  },
};

export interface SetCookieLiteral {
  readonly file: string;
  readonly line: number;
  /** The literal as written, delimiters included, so the finding quotes what to search for. */
  readonly literal: string;
}

/**
 * A literal that IS one attribute, as an array of parts is joined. Three spellings, three rules:
 * - a bare flag is matched in its canonical case only — `'secure'` is a word and an option key;
 * - `Max-Age=` is matched in its canonical case only — lowercase `max-age=` is RFC 9111's and
 *   RFC 6797's own directive, and every standalone one in the tree is cache-control or HSTS;
 * - every other `name=value` attribute in any case, shaped by its value where it has a fixed one
 *   (`path=/…`, `samesite=lax`), so `'domain'` alone or `'priority={true}'` JSX never matches.
 */
const WHOLE_FLAG = /^(?:HttpOnly|Secure|Partitioned)$/;
const WHOLE_MAX_AGE = /^Max-Age=/;
const WHOLE_VALUED =
  /^(?:Path=\/|Domain=[^\s;]|Expires=[^\s;]|SameSite=(?:Strict|Lax|None)\b|Priority=(?:Low|Medium|High)\b)/i;
/** An attribute after a `;` — the `Set-Cookie` grammar, read case-insensitively like a browser. */
const AFTER_SEMICOLON =
  /;\s*(?:(?:HttpOnly|Secure|Partitioned)\s*(?:;|$)|(?:Path|Domain|Max-Age|Expires|SameSite|Priority)=)/i;

const isCookieText = (content: string): boolean =>
  [WHOLE_FLAG, WHOLE_MAX_AGE, WHOLE_VALUED].some((shape) => shape.test(content.trim())) ||
  AFTER_SEMICOLON.test(content);

/**
 * Every literal that spells a cookie attribute, in source order. Literals are found on the MASKED
 * text — a comment is gone and a quote inside a string or a regex delimits nothing — and read back
 * from the comment-stripped text at the same offsets.
 */
export function setCookieLiterals(file: string, source: string): readonly SetCookieLiteral[] {
  if (file === COOKIE_SEAM || isTestPath(file)) return [];
  const masked = maskLiterals(source);
  const text = stripComments(source);
  const found: SetCookieLiteral[] = [];
  let at = 0;
  while (at < masked.length) {
    if (!QUOTES.has(masked[at] as string)) {
      at += 1;
      continue;
    }
    const end = endOfLiteral(text, at);
    const literal = text.slice(at, end);
    if (end > at + 1 && isCookieText(literal.slice(1, -1))) {
      found.push({ file, line: lineOf(text, at), literal });
    }
    at = end;
  }
  return found;
}

/** The header's name, in any case, as a literal's whole content. */
const HEADER_NAME = /^set-cookie$/i;
/** `.append(` / `.set(` with the name as the first argument. */
const WRITE_CALL = /\.(?:append|set)\s*\(\s*$/;

/** Whether the literal spanning `at`..`end` of `text` is the header name in a WRITING position. */
const writesHeader = (text: string, at: number, end: number): boolean => {
  const before = text.slice(Math.max(0, at - 60), at);
  const after = text.slice(end, end + 20);
  if (WRITE_CALL.test(before)) return true;
  // A key — `{ 'set-cookie': … }` — and never a ternary's arm or a `case` label.
  if (/^\s*:/.test(after)) return !/(?:\?|\bcase)\s*$/.test(before);
  // A `[name, value]` tuple head, as `new Headers([[…]])` and `signOutHeaders()` take one.
  return /\[\s*$/.test(before) && /^\s*,/.test(after);
};

/** Every `'set-cookie'` literal that writes the header, outside the two seams that may. */
export function setCookieHeaderNames(file: string, source: string): readonly SetCookieLiteral[] {
  if (file === COOKIE_SEAM || file === HEADER_SEAM || isTestPath(file)) return [];
  const masked = maskLiterals(source);
  const text = stripComments(source);
  const found: SetCookieLiteral[] = [];
  let at = 0;
  while (at < masked.length) {
    if (!QUOTES.has(masked[at] as string)) {
      at += 1;
      continue;
    }
    const end = endOfLiteral(text, at);
    const literal = text.slice(at, end);
    if (end > at + 1 && HEADER_NAME.test(literal.slice(1, -1)) && writesHeader(text, at, end)) {
      found.push({ file, line: lineOf(text, at), literal });
    }
    at = end;
  }
  return found;
}

export interface SourceText {
  readonly path: string;
  readonly source: string;
}

const handBuilt = (file: string, sites: readonly SetCookieLiteral[], pinned: number): Finding => {
  const first = sites[pinned] ?? sites[0];
  const where = `${file}:${String(first?.line ?? 1)}`;
  const listed = sites.map((site) => `${String(site.line)} ${site.literal}`).join(', ');
  return {
    code: 'X_SET_COOKIE_HAND_BUILT',
    at: where,
    cause: `${file} spells a Set-Cookie attribute by hand in ${String(sites.length)} literal(s) and is pinned at ${String(pinned)} (lines ${listed}); a hand-built line is where Secure goes missing, a clearing line stops matching its Path, and a value carrying ; ends the header early`,
    fix: `setCookie(name, value, opts)   # at ${where}: from '@ultimat3/http' in a handler, loader or action (deleteCookie(name, { path, domain }) clears); below http, serializeSetCookie(name, value, opts) from '@ultimat3/core'; then bun run set-cookie-literals --json`,
  };
};

const headerWritten = (
  file: string,
  sites: readonly SetCookieLiteral[],
  pinned: number,
): Finding => {
  const first = sites[pinned] ?? sites[0];
  const where = `${file}:${String(first?.line ?? 1)}`;
  const listed = sites.map((site) => `${String(site.line)} ${site.literal}`).join(', ');
  return {
    code: 'X_SET_COOKIE_HAND_BUILT',
    at: where,
    cause: `${file} writes the Set-Cookie header by name in ${String(sites.length)} place(s) and is pinned at ${String(pinned)} (lines ${listed}); a line that does not come from the serializer carries no Secure, HttpOnly or Path unless somebody remembered them`,
    fix: `setCookie(name, value, opts)   # at ${where}: from '@ultimat3/http' in a handler, loader or action; below http, append serializeSetCookie(name, value, opts) from '@ultimat3/core' and pin the file in SET_COOKIE_RELAY_PINS (${THIS_FILE}) naming that serializer; then bun run set-cookie-literals --json`,
  };
};

const stalePin = (file: string, found: number, pinned: number, table: string): Finding => ({
  code: 'X_SET_COOKIE_PIN_STALE',
  at: THIS_FILE,
  cause: `${file} is pinned at ${String(pinned)} in ${table} and holds ${String(found)}, so the pin would let ${String(pinned - found)} back in`,
  fix: `bun run set-cookie-literals --json   # after setting ${file} to sites: ${String(found)} in ${table} (${THIS_FILE})${found === 0 ? ', or deleting its entry' : ''}`,
});

type Pins = Readonly<Record<string, SetCookiePin>>;
type Scan = (file: string, source: string) => readonly SetCookieLiteral[];
type Over = (file: string, sites: readonly SetCookieLiteral[], pinned: number) => Finding;

/** One table's ratchet: every file over its pin, every pin above its file. */
function ratchet(files: readonly SourceText[], pins: Pins, table: string, scan: Scan, over: Over) {
  const findings: Finding[] = [];
  const counted = new Map<string, number>();
  for (const file of files) {
    const sites = scan(file.path, file.source);
    counted.set(file.path, sites.length);
    const pinned = Object.hasOwn(pins, file.path) ? (pins[file.path]?.sites ?? 0) : 0;
    if (sites.length > pinned) findings.push(over(file.path, sites, pinned));
  }
  for (const [file, pin] of Object.entries(pins)) {
    const found = counted.get(file) ?? 0;
    if (found < pin.sites) findings.push(stalePin(file, found, pin.sites, table));
  }
  return findings;
}

/** The findings over a file set: every unpinned literal or header write, every pin stale. */
export function setCookieFindings(
  files: readonly SourceText[],
  pins: Pins = SET_COOKIE_PINS,
  relays: Pins = SET_COOKIE_RELAY_PINS,
): readonly Finding[] {
  return [
    ...ratchet(files, pins, 'SET_COOKIE_PINS', setCookieLiterals, handBuilt),
    ...ratchet(files, relays, 'SET_COOKIE_RELAY_PINS', setCookieHeaderNames, headerWritten),
  ];
}

export function setCookieResult(
  files: readonly SourceText[],
  pins: Pins = SET_COOKIE_PINS,
  relays: Pins = SET_COOKIE_RELAY_PINS,
): ScriptResult {
  const findings = files.some((file) => file.path === COOKIE_SEAM)
    ? [...setCookieFindings(files, pins, relays)]
    : [
        {
          code: 'X_SET_COOKIE_UNSCANNED',
          at: THIS_FILE,
          cause: `${COOKIE_SEAM} was not among the files scanned, so the exemption names nothing and a clean run proves nothing`,
          fix: `bun run set-cookie-literals --json   # after pointing COOKIE_SEAM in ${THIS_FILE} at the module that declares serializeSetCookie`,
        },
      ];
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${String(files.length)} files, every Set-Cookie spelled by ${COOKIE_SEAM}`
        : `${String(findings.length)} hand-built Set-Cookie finding(s)`,
    findings,
    data: { files: files.length },
  };
}

const GLOBS = ['packages/*/src/**/*.{ts,tsx}', `${APP_ROOTS}/*/**/*.{ts,tsx}`];
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

export async function readSetCookieSources(root: string): Promise<readonly SourceText[]> {
  const files: SourceText[] = [];
  for (const glob of GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      const posix = path.split('\\').join('/');
      if (NOT_SOURCE.test(posix) || isTestPath(posix)) continue;
      files.push({ path: posix, source: await Bun.file(`${root}/${posix}`).text() });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(setCookieResult(await readSetCookieSources(repoRoot())), args.json);
}
