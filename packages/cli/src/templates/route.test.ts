// `x g route` is the generator an agent reaches for most, and the URL it writes is the one fact it
// cannot get wrong. These pin the two halves that were: a `[param]` segment surviving into the
// path, and the offline assertion landing in a file the `e2e` step can actually select.

import { describe, expect, test } from 'bun:test';
import { routeFiles, routeParams, routeSegment } from './route';

const pathsFor = (path: string, surface: 'site' | 'app' = 'app'): readonly string[] =>
  routeFiles(path, { surface }).map((file) => file.path);

const contentsOf = (path: string, suffix: string): string => {
  const file = routeFiles(path, { surface: 'app' }).find((entry) => entry.path.endsWith(suffix));
  if (file === undefined) throw new Error(`no ${suffix} generated for ${path}`);
  return String(file.contents);
};

describe('unit · a dynamic segment stays dynamic', () => {
  // `kebab()` strips `[` and `]` with every other non-alphanumeric, so `x g route "posts/[slug]"`
  // scaffolded `apps/web/app/posts/slug/page.tsx` — a different, STATIC route — exit 0, no warning.
  test('[slug] survives the path derivation', () => {
    expect(routeSegment('[slug]')).toBe('[slug]');
    expect(routeSegment('[...rest]')).toBe('[...rest]');
    expect(routeSegment('Blog Posts')).toBe('blog-posts');
    expect(pathsFor('posts/[slug]')).toContain('apps/web/app/posts/[slug]/page.tsx');
    expect(pathsFor('blog/[slug]', 'site')).toContain('apps/web/site/blog/[slug]/page.tsx');
  });

  test('only the parameter NAME is kebabed, never the brackets', () => {
    expect(routeSegment('[postId]')).toBe('[post-id]');
    expect(routeParams('orgs/[orgId]/posts/[slug]')).toEqual(['org-id', 'slug']);
    expect(routeParams('pricing')).toEqual([]);
  });

  test('the generated test is handed the params the URL actually declares', () => {
    const source = contentsOf('posts/[slug]', 'page.test.ts');
    // `params: {}` with a literal `[slug]` in the URL was a context no render ever produces.
    expect(source).toContain("const ctx = { params: { slug: 'slug-1' }, url:");
    expect(source).toContain("url: 'https://example.test/posts/slug-1' }");
    expect(contentsOf('pricing', 'page.test.ts')).toContain(
      "const ctx = { params: {}, url: 'https://example.test/pricing' };",
    );
  });
});

describe('unit · the offline assertion lands where the e2e step can find it', () => {
  // The gate types a test by its FILENAME. An `e2eTest` in `page.test.ts` was classified as a unit
  // test, so it could never reach the `e2e` step however it was driven.
  test('e2eTest is emitted into page.e2e.test.ts and never into page.test.ts', () => {
    expect(pathsFor('blog')).toEqual([
      'apps/web/app/blog/page.tsx',
      'apps/web/app/blog/page.module.scss',
      'apps/web/app/blog/page.test.ts',
      'apps/web/app/blog/page.e2e.test.ts',
      'packages/i18n/catalogs/en.json',
    ]);
    expect(contentsOf('blog', 'page.test.ts')).not.toContain('e2eTest');
    expect(contentsOf('blog', 'page.e2e.test.ts')).toContain('e2eTest(');
  });

  test('the e2e navigation uses the resolved URL, not the bracketed pattern', () => {
    expect(contentsOf('posts/[slug]', 'page.e2e.test.ts')).toContain(
      "await page.goto('/posts/slug-1');",
    );
  });
});

describe('unit · the generated page reads strings through the app, never past it', () => {
  const pageOf = (options: Parameters<typeof routeFiles>[1]): string => {
    const page = routeFiles('play', options).find((file) => file.path.endsWith('page.tsx'));
    // `GeneratedFile.contents` carries bytes for the generators that emit images; a `.tsx` is
    // text. Answering `''` for either miss would make every `not.toContain` below pass over
    // nothing, which is the assertion that cannot fail.
    if (typeof page?.contents !== 'string') return expect.unreachable('no page.tsx generated');
    return page.contents;
  };

  test('imports useT from the app catalog module the generator was given', () => {
    const source = pageOf({ surface: 'app', catalogModule: '@myapp/i18n' });

    expect(source).toContain("import { useT } from '@myapp/i18n';");
    expect(source).toContain('const t = useT();');
    // Registration is a side effect of importing that module. A page reaching straight for
    // `@ultimat3/i18n` renders strings while depending on nothing that registers them, which is
    // the app issue #249 reported — and the generator is where that idiom came from.
    expect(source).not.toContain("from '@ultimat3/i18n'");
  });

  test("`meta` takes the router's own `t`, so the page has one import and not two", () => {
    expect(pageOf({ surface: 'site', catalogModule: '@myapp/i18n' })).toContain('meta: ({ t }) =>');
  });

  test('an app with no catalog module keeps the framework import — never one that cannot resolve', () => {
    const source = pageOf({ surface: 'app' });

    expect(source).toContain("import { t } from '@ultimat3/i18n';");
    expect(source).not.toContain('useT');
  });
});
