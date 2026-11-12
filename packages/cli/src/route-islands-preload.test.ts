// The `<link rel="modulepreload">` tags a document carries for the islands it rendered: each shared
// chunk an eagerly booted island imports, once, so the browser fetches them beside the entry rather
// than after parsing it — and nothing at all on a page that rendered no island (axiom 6).

import { describe, expect, test } from 'bun:test';
import type { RouteEntry } from '@ultimat3/render';
import type { DocumentOptions, IslandResolve } from './document-options';
import { collectorFor, streamScripts } from './route-islands';
import { linkHeader, preloadTags, preloadUrls } from './route-islands-preload';

const PAGE = 'apps/web/app/posts/page.tsx';
const RUNTIME = '/islands/page-runtime.abc123.js';
const SHARED = '/islands/chunk-11111111.js';
const OTHER = '/islands/chunk-22222222.js';

/** What the served bundle's resolver answers: an entry URL per src, and what each entry loads. */
const IMPORTS: Readonly<Record<string, readonly string[]>> = {
  '/islands/form-1.js': [SHARED, RUNTIME],
  '/islands/list-2.js': [OTHER, SHARED],
  '/islands/plain-3.js': [],
};
const resolve: IslandResolve = Object.assign(
  (src: string): string =>
    ({
      './form.island.tsx': '/islands/form-1.js',
      './list.island.tsx': '/islands/list-2.js',
      './plain.island.tsx': '/islands/plain-3.js',
    })[src] ?? src,
  { importsOf: (url: string): readonly string[] => IMPORTS[url] ?? [] },
);
const OPTIONS: DocumentOptions = { resolveIsland: () => resolve };

const routeEntry = (hydrate: string): RouteEntry =>
  ({ file: PAGE, config: { hydrate } }) as unknown as RouteEntry;
const spec = (name: string) => ({
  moduleId: name,
  src: `./${name}.island.tsx`,
  propKeys: [],
  tag: 'div' as const,
});

const linksIn = (html: string): readonly string[] =>
  [...html.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map((m) => m[1] ?? '');

describe('preloadTags', () => {
  test('a page with one island lists every chunk that island imports', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    islands.record(spec('form'), {});
    expect(linksIn(preloadTags(entry, islands, OPTIONS, false))).toEqual([SHARED, RUNTIME]);
  });

  test('a page that rendered no island carries no preload at all', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    expect(preloadTags(entry, islands, OPTIONS, false)).toBe('');
  });

  test('a chunk two islands share, and two instances of one island, are one link', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    islands.record(spec('form'), {});
    islands.record(spec('form'), {});
    islands.record(spec('list'), {});
    islands.record(spec('plain'), {});
    expect(linksIn(preloadTags(entry, islands, OPTIONS, false))).toEqual([SHARED, OTHER, RUNTIME]);
  });

  test('a document carrying the page boot never preloads the runtime chunk the boot supplies', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    islands.record(spec('form'), {});
    expect(linksIn(preloadTags(entry, islands, OPTIONS, true))).toEqual([SHARED]);
  });

  test('an island deferred until visible or interacted with fetches nothing early', () => {
    for (const hydrate of ['visible', 'interaction']) {
      const entry = routeEntry(hydrate);
      const islands = collectorFor(entry, OPTIONS, undefined);
      islands.record(spec('form'), {});
      expect(preloadTags(entry, islands, OPTIONS, false)).toBe('');
    }
  });

  test('a resolver that knows no imports (a test double, an older bundle) emits nothing', () => {
    const entry = routeEntry('idle');
    const bare: DocumentOptions = { resolveIsland: () => (src: string) => src };
    const islands = collectorFor(entry, bare, undefined);
    islands.record(spec('form'), {});
    expect(preloadTags(entry, islands, bare, false)).toBe('');
  });
});

describe('streamScripts preloads', () => {
  test('the first flush preloads the shell islands; a hole adds only what was not linked yet', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    islands.record(spec('form'), {});
    const scripts = streamScripts(entry, islands, OPTIONS, undefined, true);
    expect(linksIn(scripts.first)).toEqual([SHARED, RUNTIME]);
    islands.record(spec('list'), {});
    expect(linksIn(scripts.after('filled'))).toEqual([OTHER]);
  });
});

describe('linkHeader', () => {
  test('the stylesheet as a style preload, then each chunk as a modulepreload, in order', () => {
    expect(linkHeader('/styles/abc.css', [SHARED, OTHER])).toBe(
      `</styles/abc.css>; rel=preload; as=style, <${SHARED}>; rel=modulepreload, <${OTHER}>; rel=modulepreload`,
    );
  });

  test('a document with no stylesheet and no preload carries no header at all', () => {
    expect(linkHeader(undefined, [])).toBeUndefined();
  });

  test('a URL that would break the header out of its brackets is left to the tag alone', () => {
    expect(linkHeader('/styles/a>.css', ['/islands/a, b.js', SHARED])).toBe(
      `<${SHARED}>; rel=modulepreload`,
    );
  });

  test('a URL carrying its own `>;` cannot smuggle a second link past the check', () => {
    // The text before the FIRST `>;` is header-safe; the rest would be a link to another origin.
    const smuggled = '/islands/a.js>; rel=preload; as=fetch, <https://evil.example/x.js';
    expect(linkHeader(smuggled, [smuggled, SHARED])).toBe(`<${SHARED}>; rel=modulepreload`);
  });

  test('preloadUrls is the set preloadTags writes, URL for URL', () => {
    const entry = routeEntry('idle');
    const islands = collectorFor(entry, OPTIONS, undefined);
    islands.record(spec('form'), {});
    islands.record(spec('list'), {});
    expect(preloadUrls(entry, islands, OPTIONS, false)).toEqual(
      linksIn(preloadTags(entry, islands, OPTIONS, false)),
    );
  });
});
