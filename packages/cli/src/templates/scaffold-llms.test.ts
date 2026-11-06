// `/llms.txt` on a freshly scaffolded app: every `site/` page `x new` writes is either listed —
// and then declares the `meta.description` its line carries — or says `robots: { index: false }`.
// The `seo` step refuses a listed page with none (`X_SEO_LLMS_DESCRIPTION_MISSING`), so a scaffold
// that wrote one would fail its own first `x verify`.

import { describe, expect, test } from 'bun:test';
import { planNewApp } from '../cmd-new';

const SITE_PAGE = /^apps\/web\/site\/(?:.+\/)?page\.tsx$/;

/** The `meta: (…) => ({ … })` object literal of a page module, as text. */
const metaOf = (source: string): string => {
  const start = source.indexOf('meta:');
  if (start === -1) return expect.unreachable('a site page declares meta');
  const end = source.indexOf('}),', start);
  return source.slice(start, end === -1 ? undefined : end);
};

describe.each([
  { shape: 'demoapp', example: true },
  { shape: 'bareapp', example: false },
])('the $shape scaffold', ({ example }) => {
  const pages = planNewApp({ name: 'llms-demo', example }).filter((file) =>
    SITE_PAGE.test(file.path),
  );

  test('writes at least the home page', () => {
    expect(pages.map((page) => page.path)).toContain('apps/web/site/page.tsx');
  });

  test('every listed site page declares a meta.description', () => {
    for (const page of pages) {
      if (typeof page.contents !== 'string') return expect.unreachable(`${page.path} is text`);
      const meta = metaOf(page.contents);
      const listed = !/robots:\s*\{\s*index:\s*false/.test(meta);
      if (listed)
        expect({ path: page.path, described: /\bdescription:/.test(meta) }).toEqual({
          path: page.path,
          described: true,
        });
    }
  });
});
