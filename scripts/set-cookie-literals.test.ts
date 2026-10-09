// biome-ignore-all lint/suspicious/noTemplateCurlyInString: every fixture below is SOURCE TEXT — a
// literal ${…} inside a single-quoted string is the cookie-building shape under test.
// The enforcement half of `scripts/set-cookie-literals.ts`, run by the gate's `unit` step like every
// `scripts/**/*.test.ts`: a hand-spelled `Set-Cookie` re-entering the tree fails `bun run verify`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import {
  COOKIE_SEAM,
  HEADER_SEAM,
  readSetCookieSources,
  SET_COOKIE_PINS,
  SET_COOKIE_RELAY_PINS,
  setCookieFindings,
  setCookieHeaderNames,
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
    expect(quoted(source, 'examples/dummy/apps/web/app/auth/actions/end-session.ts')).toHaveLength(
      1,
    );
  });

  test('a standalone name=value attribute is read in any case — joined parts are a cookie too', () => {
    const source =
      "[`${n}=${v}`, 'path=/', 'samesite=lax', 'domain=example.com', `expires=${d}`, 'priority=high']";
    expect(quoted(source)).toEqual([
      "'path=/'",
      "'samesite=lax'",
      "'domain=example.com'",
      '`expires=${d}`',
      "'priority=high'",
    ]);
    expect(quoted("['SAMESITE=Strict', 'Path=/app']")).toEqual([
      "'SAMESITE=Strict'",
      "'Path=/app'",
    ]);
  });

  test('the attribute after a semicolon is read in any case — a browser reads it so', () => {
    expect(quoted("const c = 'sid=1; httponly';")).toEqual(["'sid=1; httponly'"]);
    expect(quoted("const c = 'sid=1; path=/x';")).toEqual(["'sid=1; path=/x'"]);
  });

  test('the finding is an edit naming the file and both seams, and the re-run', () => {
    const [site] = setCookieLiterals(AT, "const c = 'a=b; HttpOnly';");
    const result = setCookieResult(
      [seam, { path: AT, source: "const c = 'a=b; HttpOnly';" }],
      {},
      {},
    );
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

  test('a lowercase standalone max-age= is a cache-control or HSTS directive, never a cookie', () => {
    // RFC 9111 and RFC 6797 spell the directive `max-age`; the cookie attribute is `Max-Age`. The
    // tree's five standalone `max-age=` literals are all cache-control or HSTS (measured).
    expect(quoted('const hsts = `max-age=${config.hsts.maxAgeSeconds}`;')).toEqual([]);
    expect(quoted("headers.set('cache-control', 'max-age=3600');")).toEqual([]);
    expect(quoted('parts.push(`Max-Age=${s}`);')).toEqual(['`Max-Age=${s}`']);
  });

  test('a bare flag is case-sensitive: a lowercase word or option key is not an attribute', () => {
    expect(quoted("const mode = 'secure'; const k = 'httponly'; const p = 'partitioned';")).toEqual(
      [],
    );
    expect(quoted("const domain = 'domain'; const path = 'path';")).toEqual([]);
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

// Sweep 11 R4: a hand-built line with NO attribute carried nothing the attribute scan reads, so
// `headers: { 'set-cookie': `sid=${t}` }` — a cookie with no Secure, no HttpOnly, no Path — slipped.
// The header NAME is what such a line cannot avoid writing.
describe('a Set-Cookie header written by name', () => {
  const names = (source: string, file = AT): readonly number[] =>
    setCookieHeaderNames(file, source).map((site) => site.line);

  test('the attribute-free line the attribute scan could not see', () => {
    const source = "return new Response(null, {\n  headers: { 'set-cookie': `sid=${t}` },\n});";
    expect(quoted(source)).toEqual([]);
    expect(names(source)).toEqual([2]);
    const result = setCookieResult([seam, { path: AT, source }], {}, {});
    expect(result.findings?.map((f) => f.code)).toEqual(['X_SET_COOKIE_HAND_BUILT']);
    expect(result.findings?.[0]?.at).toBe(`${AT}:2`);
    expect(result.findings?.[0]?.fix).toContain('serializeSetCookie');
  });

  test('as a headers key, an append or set argument, or a tuple head — in any case', () => {
    expect(names("new Headers({ 'Set-Cookie': line });")).toEqual([1]);
    expect(names('headers.append("set-cookie", line);')).toEqual([1]);
    expect(names('headers.set(`SET-COOKIE`, line);')).toEqual([1]);
    expect(names("return [['set-cookie', line]];")).toEqual([1]);
  });

  test('reading, comparing or redacting the name is not writing one', () => {
    expect(names("const all = request.headers.get('set-cookie');")).toEqual([]);
    expect(names("if (name === 'set-cookie') headers.append(name, value);")).toEqual([]);
    expect(names("const redacted = new Set(['cookie', 'set-cookie']);")).toEqual([]);
    expect(names("// headers.append('set-cookie', x)")).toEqual([]);
  });

  test('the two seams that write the header, and a test, are not reported', () => {
    const source = "ctx.headers.append('set-cookie', serializeSetCookie(name, value, options));";
    expect(names(source, HEADER_SEAM)).toEqual([]);
    expect(names(source, COOKIE_SEAM)).toEqual([]);
    expect(names(source, 'packages/auth/src/session.test.ts')).toEqual([]);
  });

  test('a relay pin holds its file at its count — a third line is a finding, a lost one stale', () => {
    const relay = { [AT]: { sites: 1, why: 'appends sessionCookie(), serializeSetCookie output' } };
    const one = { path: AT, source: "headers.append('set-cookie', sessionCookie(t, p));" };
    expect(setCookieResult([seam, one], {}, relay).findings).toEqual([]);
    const two = { path: AT, source: `${one.source}\nheaders.append('set-cookie', \`sid=\${t}\`);` };
    expect(setCookieResult([seam, two], {}, relay).findings?.map((f) => f.code)).toEqual([
      'X_SET_COOKIE_HAND_BUILT',
    ]);
    const none = { path: AT, source: 'const x = 1;' };
    expect(setCookieResult([seam, none], {}, relay).findings?.map((f) => f.code)).toEqual([
      'X_SET_COOKIE_PIN_STALE',
    ]);
  });

  test('every relay pin says which serializer-built value it appends', () => {
    for (const [file, pin] of Object.entries(SET_COOKIE_RELAY_PINS)) {
      expect(file.startsWith('packages/auth/src/')).toBe(true);
      expect(pin.why).toContain('serializeSetCookie');
      expect(pin.sites).toBeGreaterThan(0);
    }
  });
});

describe('the rule over a file set', () => {
  const pinned = { [AT]: { sites: 1, why: 'migrates in a later sweep' } };

  test('a pinned file may hold its count, never more', () => {
    const one = { path: AT, source: "const c = 'a=b; HttpOnly';" };
    expect(setCookieResult([seam, one], pinned, {}).findings).toEqual([]);
    const two = { path: AT, source: "const c = 'a=b; HttpOnly';\nconst d = 'Path=/';" };
    expect(setCookieResult([seam, two], pinned, {}).findings?.map((f) => f.code)).toEqual([
      'X_SET_COOKIE_HAND_BUILT',
    ]);
  });

  test('a pin above what the file holds is stale, so it cannot let one back in', () => {
    const result = setCookieResult([seam, { path: AT, source: 'const c = 1;' }], pinned, {});
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
