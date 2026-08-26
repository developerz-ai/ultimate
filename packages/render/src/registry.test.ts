import { beforeEach, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { RouteDuplicateError, RouteFileInvalidError, SurfaceBoundaryError } from './errors';
import {
  clearRoutes,
  compilePattern,
  decodeSegment,
  describeRoutes,
  registerRoute,
  routeCount,
  routeEntries,
  routePathFromFile,
} from './registry';
import type { RouteMetaFn } from './route';
import { defineRoute } from './route';
import type { Surface } from './surfaces';

/** The thrown error itself, so a test can assert on `code`, `cause` and `fix` together. */
const thrownBy = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  // `expect.unreachable` fails through the runner, so the caller sees its own assertion rather
  // than a stack from inside this helper — and a bare throw here would carry no code and no fix.
  return expect.unreachable('expected an UltimateError');
};

/**
 * A minimal POSIX word-split — single-quoted spans and the `\'` escape `shellQuote` uses for an
 * embedded quote, nothing else, because that is the entire grammar `assertRouteFilename`'s `fix:`
 * ever emits. Reconstructing the argument list this way proves the security property directly: a
 * shell fed this string sees the dynamic operand as exactly one argument, byte-for-byte the
 * original path, whatever metacharacters it held — rather than trusting a second copy of the
 * quoting logic to agree with the first.
 */
function shellWords(command: string): readonly string[] {
  const words: string[] = [];
  let current = '';
  let inWord = false;
  let i = 0;
  while (i < command.length) {
    const ch = command[i] as string;
    if (/\s/.test(ch)) {
      if (inWord) words.push(current);
      current = '';
      inWord = false;
      i += 1;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const close = command.indexOf("'", i + 1);
      if (close === -1) throw new Error(`unterminated quote in: ${command}`);
      current += command.slice(i + 1, close);
      i = close + 1;
      continue;
    }
    if (ch === '\\' && command[i + 1] !== undefined) {
      current += command[i + 1];
      i += 2;
      continue;
    }
    current += ch;
    i += 1;
  }
  if (inWord) words.push(current);
  return words;
}

const meta = (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn;

const staticConfig = defineRoute({
  render: 'static',
  offline: 'precache',
  hydrate: 'never',
  meta,
});

beforeEach(() => {
  clearRoutes();
});

describe('routePathFromFile', () => {
  test.each<[string, Surface, string]>([
    ['apps/web/site/page.tsx', 'site', '/'],
    ['apps/web/site/pricing/page.tsx', 'site', '/pricing'],
    ['apps/web/site/(marketing)/about/page.tsx', 'site', '/about'],
    ['apps/web/site/blog/[slug]/page.tsx', 'site', '/blog/:slug'],
    ['apps/web/site/docs/[...path]/page.tsx', 'site', '/docs/*path'],
    ['apps/web/app/dashboard/page.tsx', 'app', '/dashboard'],
    ['apps/web/api/posts/route.ts', 'api', '/api/posts'],
  ])('%s → %s %s', (file, surface, path) => {
    expect(routePathFromFile(file)).toEqual({ surface, path });
  });

  // The surface is where `surfaceOf`'s ANCHORED regex found it, and the URL is everything after
  // THAT. A bare `indexOf('app/')` matched inside `myapp/` and `offsite/`, so every route in an
  // app directory whose name merely ends in a surface name was served one segment too deep.
  test.each<[string, Surface, string]>([
    ['apps/myapp/app/page.tsx', 'app', '/'],
    ['apps/myapp/app/dashboard/page.tsx', 'app', '/dashboard'],
    ['packages/offsite/site/pricing/page.tsx', 'site', '/pricing'],
    ['services/webapi/api/posts/route.ts', 'api', '/api/posts'],
  ])('a directory ending in a surface name is not the surface: %s → %s', (file, surface, path) => {
    expect(routePathFromFile(file)).toEqual({ surface, path });
  });
});

describe('one route filename per surface', () => {
  // Every spelling the framework used to accept, or that a Next/Vite habit produces. Each one is
  // now a build error: two spellings make "is this file a route?" undecidable from the folder.
  test.each([
    ['apps/web/site/pricing.tsx', 'apps/web/site/pricing/page.tsx'],
    ['apps/web/site/blog/[slug].tsx', 'apps/web/site/blog/[slug]/page.tsx'],
    ['apps/web/app/feed.tsx', 'apps/web/app/feed/page.tsx'],
  ])('%s is refused, and the fix creates the directory it always meant', (file, target) => {
    const failure = thrownBy(() => routePathFromFile(file));
    expect(failure).toBeInstanceOf(RouteFileInvalidError);
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.cause).toContain(file);
    const stem = target.slice(0, target.lastIndexOf('/'));
    expect(failure.fix).toBe(`mkdir -p -- '${stem}' && mv -n -- '${file}' '${target}'`);
  });

  test.each([
    ['apps/web/site/index.tsx', 'apps/web/site/page.tsx'],
    ['apps/web/site/blog/index.tsx', 'apps/web/site/blog/page.tsx'],
    // `route.ts` is the api/ spelling and `page.tsx` the page one — each is wrong on the other
    // surface, and both already meant "this directory", so the repair is a rename in place.
    ['apps/web/app/reports/route.ts', 'apps/web/app/reports/page.tsx'],
    ['apps/web/api/posts/page.tsx', 'apps/web/api/posts/route.ts'],
  ])('%s already meant its directory, so the fix renames in place', (file, target) => {
    const failure = thrownBy(() => routePathFromFile(file));
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.fix).toBe(`mv -n -- '${file}' '${target}'`);
  });

  test('shared/ is a leaf: no filename makes a route there', () => {
    const failure = thrownBy(() => routePathFromFile('apps/web/shared/page.tsx'));
    expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
    expect(failure.cause).toContain('shared/');
  });

  test('registerRoute refuses it too — the table never holds an unnameable file', () => {
    expect(() =>
      registerRoute({ file: 'apps/web/site/pricing.tsx', config: staticConfig }),
    ).toThrow(RouteFileInvalidError);
    expect(routeEntries()).toHaveLength(0);
  });

  test('a path override does not buy an exemption: the file still has to be a route file', () => {
    // `path` exists for locale roots and rewrites, not as a way around the naming rule — the
    // module scan still has to recognise the file, and the override says nothing about that.
    expect(() =>
      registerRoute({ file: 'apps/web/site/pricing.tsx', config: staticConfig, path: '/tarifs' }),
    ).toThrow(RouteFileInvalidError);
  });

  // The `fix:` is copied into a shell verbatim (axiom 4). The file path is filesystem-derived,
  // not attacker input in the traditional sense, but a space, an apostrophe or a shell
  // metacharacter must still not change what command actually runs when it is pasted.
  describe('the fix command quotes every filesystem-derived operand', () => {
    test('a space in the filename does not split the fix into extra arguments', () => {
      const file = 'apps/web/site/my page.tsx';
      const target = 'apps/web/site/my page/page.tsx';
      const failure = thrownBy(() => routePathFromFile(file));
      expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
      expect(shellWords(failure.fix)).toEqual([
        'mkdir',
        '-p',
        '--',
        'apps/web/site/my page',
        '&&',
        'mv',
        '-n',
        '--',
        file,
        target,
      ]);
    });

    test('an apostrophe in the filename cannot close the quote early', () => {
      const file = "apps/web/site/o'brien.tsx";
      const target = "apps/web/site/o'brien/page.tsx";
      const failure = thrownBy(() => routePathFromFile(file));
      expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
      // Reconstructed through independent quote-removal, not a copy of `shellQuote` — a naive
      // `'${value}'` wrap with no escaping would let the embedded `'` close the quote early and
      // either throw here (unterminated quote) or silently drop the apostrophe.
      expect(shellWords(failure.fix)).toEqual([
        'mkdir',
        '-p',
        '--',
        "apps/web/site/o'brien",
        '&&',
        'mv',
        '-n',
        '--',
        file,
        target,
      ]);
    });

    test('a command-substitution-shaped segment stays inert inside single quotes', () => {
      const file = 'apps/web/app/`whoami`/index.tsx';
      const target = 'apps/web/app/`whoami`/page.tsx';
      const failure = thrownBy(() => routePathFromFile(file));
      expect(failure.code).toBe('X_ROUTE_FILE_INVALID');
      // Word-splitting alone would not catch a missing quote here — `` `whoami` `` carries no
      // whitespace, so an unquoted operand still reads as one argument either way. What makes it
      // inert is sitting inside a single-quoted span, where POSIX gives backticks and `$()` no
      // meaning at all; asserting the exact quoted substring is what actually proves that.
      expect(failure.fix).toContain(`'${file}'`);
      expect(failure.fix).toContain(`'${target}'`);
      expect(shellWords(failure.fix)).toEqual(['mv', '-n', '--', file, target]);
    });
  });
});

describe('route table', () => {
  test('two files claiming one URL is a build error', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: staticConfig });
    expect(() =>
      registerRoute({ file: 'apps/web/site/(marketing)/pricing/page.tsx', config: staticConfig }),
    ).toThrow(RouteDuplicateError);
  });

  test('describeRoutes is sorted, JSON-safe and identical for identical input', () => {
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/blog/[slug]/page.tsx', config: staticConfig });

    const first = describeRoutes();
    expect(first.map((r) => r.path)).toEqual(['/', '/blog/:slug', '/pricing']);
    expect(JSON.stringify(first)).toBe(JSON.stringify(describeRoutes()));
    expect(first.find((r) => r.path === '/blog/:slug')?.dynamic).toBe(true);
  });

  // This package's own `matchRoute` is gone — `@ultimat3/http`'s trie (`stages.ts`) is the one
  // matcher, and two exported matchers with different precedence rules is one too many. What it
  // read stays exported and stays covered here: the compiled pattern a route registers, and the
  // "is this segment decodable?" answer that keeps a typo from being a 500.
  test('the compiled pattern is what ranks and captures, and it is on the entry', () => {
    const entry = registerRoute({
      file: 'apps/web/site/blog/[slug]/page.tsx',
      config: staticConfig,
    });
    const literal = registerRoute({
      file: 'apps/web/site/blog/feed/page.tsx',
      config: staticConfig,
    });

    // A literal segment outranks a param, so a matcher sorting on specificity picks `/blog/feed`.
    expect(literal.pattern.specificity).toBeGreaterThan(entry.pattern.specificity);
    expect(entry.pattern.regex.exec('/blog/hello-world')?.[1]).toBe('hello-world');
    expect(entry.pattern.keys).toEqual(['slug']);
    expect(entry.pattern.regex.exec('/nope')).toBe(null);
  });

  // A pathname is whatever the client typed. `decodeURIComponent('%zz')` throws a bare `URIError`
  // — no code, no fix, a 500 and an error-monitor page for a typo — where `@ultimat3/http`'s own
  // router already answers "this branch does not match" for the same input.
  test('a segment that will not decode answers undefined, and never throws', () => {
    for (const bad of ['%zz', '%', '%A', 'a%2', '%E0%A4%A']) {
      expect(() => decodeSegment(bad)).not.toThrow();
      expect(decodeSegment(bad)).toBeUndefined();
    }
    expect(decodeSegment('a%20b')).toBe('a b');
  });

  test('a route path that is itself an undecodable escape still registers as a literal', () => {
    const entry = registerRoute({
      file: 'apps/web/site/blog/%zz/page.tsx',
      config: staticConfig,
    });
    expect(entry.path).toBe('/blog/%zz');
    expect(entry.pattern.keys).toEqual([]);
    expect(entry.pattern.regex.exec('/blog/%zz')).not.toBe(null);
  });
});

describe('a file outside every surface has no URL at all', () => {
  // The surface is the bundle graph. A file that is in none of them cannot be given a URL by
  // guessing one — axiom 6 is the reason this is a refusal and not a default.
  test.each([
    'apps/web/components/button.tsx',
    'page.tsx',
    'apps/web/lib/site-utils/page.tsx',
    'apps/web/apiary/route.ts',
  ])('%s is refused rather than mounted', (file) => {
    const error = thrownBy(() => routePathFromFile(file));
    expect(error.code).toBe('X_SURFACE_BOUNDARY');
    expect(error.cause).toContain(file);
    expect(error.fix).toContain('site/, app/ or api/');
  });

  test('registerRoute refuses it too, so nothing lands in the table', () => {
    expect(() =>
      registerRoute({ file: 'apps/web/components/button.tsx', config: staticConfig }),
    ).toThrow(SurfaceBoundaryError);
    expect(routeCount()).toBe(0);
  });
});

describe('a catch-all segment', () => {
  test('matches one segment, many segments, and the empty rest', () => {
    const entry = registerRoute({
      file: 'apps/web/site/docs/[...path]/page.tsx',
      config: staticConfig,
    });
    expect(entry.pattern.regex.exec('/docs/a')?.[1]).toBe('a');
    expect(entry.pattern.regex.exec('/docs/a/b/c')?.[1]).toBe('a/b/c');
    expect(entry.pattern.regex.exec('/docs/')?.[1]).toBe('');
    expect(entry.pattern.regex.exec('/other/a')).toBe(null);
  });

  test('is the least specific pattern, so a literal and a param both outrank it', () => {
    const catchAll = registerRoute({
      file: 'apps/web/site/docs/[...path]/page.tsx',
      config: staticConfig,
    });
    const param = registerRoute({
      file: 'apps/web/site/docs/[slug]/page.tsx',
      config: staticConfig,
    });
    const literal = registerRoute({
      file: 'apps/web/site/docs/intro/page.tsx',
      config: staticConfig,
    });

    expect(literal.pattern.specificity).toBeGreaterThan(param.pattern.specificity);
    expect(param.pattern.specificity).toBeGreaterThan(catchAll.pattern.specificity);
    // All three regexes claim `/docs/intro`; specificity is the only thing that separates them.
    for (const entry of [catchAll, param, literal]) {
      expect(entry.pattern.regex.exec('/docs/intro')).not.toBe(null);
    }
    expect(literal.pattern.regex.exec('/docs/a/b')).toBe(null);
    expect(param.pattern.regex.exec('/docs/a/b')).toBe(null);
    expect(catchAll.pattern.regex.exec('/docs/a/b')?.[1]).toBe('a/b');
  });

  test('compilePattern reports the key and the specificity it was ranked by', () => {
    const catchAll = compilePattern('/docs/*path');
    expect(catchAll.keys).toEqual(['path']);
    expect(compilePattern('/docs/:slug').specificity).toBeGreaterThan(catchAll.specificity);
    expect(compilePattern('/docs/intro').specificity).toBeGreaterThan(
      compilePattern('/docs/:slug').specificity,
    );
  });
});

describe('routeCount', () => {
  test('counts registered routes and is reset by clearRoutes', () => {
    expect(routeCount()).toBe(0);
    registerRoute({ file: 'apps/web/site/page.tsx', config: staticConfig });
    registerRoute({ file: 'apps/web/site/pricing/page.tsx', config: staticConfig });
    expect(routeCount()).toBe(2);
    expect(routeCount()).toBe(routeEntries().length);
    clearRoutes();
    expect(routeCount()).toBe(0);
  });
});

/**
 * `ctx.suspenseBoundaries < 1` is the only thing standing between `render: 'stream'` and a route
 * that streams nothing — and `NaN < 1` is false, so a count that arrived non-finite does not
 * report a route with no boundary, it stops reporting any route at all.
 */
describe('the suspense count is a number or it is refused', () => {
  test('a NaN count no longer lets a stream route with no <Suspense> register', () => {
    const error = thrownBy(() =>
      registerRoute({
        file: 'apps/web/app/feed/page.tsx',
        config: defineRoute({
          render: 'stream',
          offline: 'network-only',
          hydrate: 'never',
          meta: (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn,
        }),
        suspenseBoundaries: Number.NaN,
      }),
    );
    expect(error.cause).toMatch(/suspenseBoundaries/);
  });

  test('a real count still registers', () => {
    expect(
      registerRoute({
        file: 'apps/web/app/feed/page.tsx',
        config: defineRoute({
          render: 'stream',
          offline: 'network-only',
          hydrate: 'never',
          meta: (() => ({ title: 'T', description: 'd'.repeat(60) })) as unknown as RouteMetaFn,
        }),
        suspenseBoundaries: 1,
      }).suspenseBoundaries,
    ).toBe(1);
  });
});
