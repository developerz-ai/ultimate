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
