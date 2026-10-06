// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a single-quoted string is the cookie-building shape under test.
// The enforcement half of `scripts/set-cookie-literals.ts`, run by the gate's `unit` step like every
// `scripts/**/*.test.ts`: a hand-spelled `Set-Cookie` re-entering the tree fails `bun run verify`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  COOKIE_SEAM,
  readSetCookieSources,
  SET_COOKIE_PINS,
  setCookieFindings,
  setCookieLiterals,
  setCookieResult,
} from './set-cookie-literals';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'packages/auth/src/session.ts';
const quoted = (source: string, file = AT): readonly string[] =>
  setCookieLiterals(file, source).map((site) => site.literal);
const seam = { path: COOKIE_SEAM, source: 'export const x = 1;' };

describe('a Set-Cookie spelled by hand', () => {
  test('the literal auth shipped until sweep 10b is reported, wherever it sits', () => {
    const source =
      'return `${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;';
    expect(quoted(source)).toEqual([
      '`${name}=${token}; Path=/; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`',
    ]);
  });

  test('a cookie assembled from attribute literals in an array is reported, one per attribute', () => {
    const source = "[`${n}=${v}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${s}`].join('; ')";
    expect(quoted(source)).toEqual(["'Path=/'", "'HttpOnly'", "'SameSite=Lax'", '`Max-Age=${s}`']);
  });

  test('a demo cookie appended straight onto the header bag is reported', () => {
    const source = "ctx.headers.append('set-cookie', `${NAME}=${OUT}; Path=/; SameSite=Lax`);";
    expect(quoted(source, 'examples/dummy/apps/web/app/auth/actions.ts')).toHaveLength(1);
  });

  test('the attribute after a semicolon is read in any case — a browser reads it so', () => {
    expect(quoted("const c = 'sid=1; httponly';")).toEqual(["'sid=1; httponly'"]);
    expect(quoted("const c = 'sid=1; path=/x';")).toEqual(["'sid=1; path=/x'"]);
  });

  test('the finding is an edit naming the file and both seams, and the re-run', () => {
    const [site] = setCookieLiterals(AT, "const c = 'a=b; HttpOnly';");
    const result = setCookieResult([seam, { path: AT, source: "const c = 'a=b; HttpOnly';" }], {});
    expect(site?.line).toBe(1);
    const finding = result.findings?.[0];
    expect(finding?.code).toBe('X_SET_COOKIE_HAND_BUILT');
    expect(finding?.at).toBe(`${AT}:1`);
    expect(finding?.fix?.startsWith('setCookie(name, value, opts)   # at ')).toBe(true);
    expect(finding?.fix).toContain("from '@ultimat3/http'");
    expect(finding?.fix).toContain("serializeSetCookie(name, value, opts) from '@ultimat3/core'");
    expect(finding?.fix).toContain(`${AT}:1`);
    expect(finding?.fix).toContain('bun run set-cookie-literals --json');
  });
});

describe('what is never reported', () => {
  test('prose that names an attribute, a cache-control age, a comment', () => {
    expect(
      quoted("cause: 'the cookie carries `Max-Age=NaN`, which is not delta-seconds',"),
    ).toEqual([]);
    expect(quoted("headers.set('cache-control', 'public, max-age=60, immutable');")).toEqual([]);
    expect(quoted('// a literal `sid=1; Path=/; HttpOnly` in a comment')).toEqual([]);
    expect(quoted("const mode = 'secure';")).toEqual([]);
  });

  test('a cookie written through the serializer, with attributes as options', () => {
    expect(quoted("serializeSetCookie(name, token, { maxAge, path: '/app' });")).toEqual([]);
    expect(quoted("setCookie('theme', 'dark', { sameSite: 'Strict' });")).toEqual([]);
  });

  test('the serializer itself, and a test, which is a fixture', () => {
    const source = "header += '; HttpOnly';";
    expect(quoted(source, COOKIE_SEAM)).toEqual([]);
    expect(quoted(source, 'packages/auth/src/session.test.ts')).toEqual([]);
    expect(quoted(source, 'packages/auth/src/other.ts')).toEqual(["'; HttpOnly'"]);
  });
});

describe('the rule over a file set', () => {
  const pinned = { [AT]: { sites: 1, why: 'migrates in a later sweep' } };

  test('a pinned file may hold its count, never more', () => {
    const one = { path: AT, source: "const c = 'a=b; HttpOnly';" };
    expect(setCookieResult([seam, one], pinned).findings).toEqual([]);
    const two = { path: AT, source: "const c = 'a=b; HttpOnly';\nconst d = 'Path=/';" };
    expect(setCookieResult([seam, two], pinned).findings?.map((f) => f.code)).toEqual([
      'X_SET_COOKIE_HAND_BUILT',
    ]);
  });

  test('a pin above what the file holds is stale, so it cannot let one back in', () => {
    const result = setCookieResult([seam, { path: AT, source: 'const c = 1;' }], pinned);
    expect(result.findings?.map((f) => f.code)).toEqual(['X_SET_COOKIE_PIN_STALE']);
    expect(result.findings?.[0]?.fix).toContain(AT);
  });

  test('a set that never contained the serializer is refused, never read as clean', () => {
    const result = setCookieResult([{ path: AT, source: 'const x = 1;' }], {});
    expect(result.ok).toBe(false);
    expect(result.findings?.map((f) => f.code)).toEqual(['X_SET_COOKIE_UNSCANNED']);
  });

  test('the tree is zero-pinned — a waiver is an edit to this line, in review', () => {
    expect(SET_COOKIE_PINS).toEqual({});
  });

  test('the command it names is a script this repo declares', async () => {
    const raw: unknown = await Bun.file(`${repoRoot()}/package.json`).json();
    const scripts = typeof raw === 'object' && raw !== null && 'scripts' in raw ? raw.scripts : {};
    expect(Object.keys(scripts ?? {})).toContain('set-cookie-literals');
  });

  test('the real tree spells every Set-Cookie through the one serializer', async () => {
    const files = await readSetCookieSources(repoRoot());
    // Non-vacuity: the seam, auth and both tracked apps are in the set the rule read.
    expect(files.some((file) => file.path === COOKIE_SEAM)).toBe(true);
    expect(files.some((file) => file.path === 'packages/auth/src/session.ts')).toBe(true);
    expect(files.some((file) => file.path.startsWith('examples/dummy/apps/'))).toBe(true);
    expect(files.some((file) => file.path.startsWith('dummy/social-media-clone/apps/'))).toBe(true);
    expect(setCookieFindings(files)).toEqual([]);
  });
});
