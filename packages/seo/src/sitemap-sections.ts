// Single responsibility: which named section of a sitemap index a page files under. The shape and
// its refusals are `@ultimat3/core`'s (`seo.sitemap.sections`), so `defineConfig` and a direct
// `buildSitemap` call reject the same things in the same words.

import {
  assert,
  SITEMAP_DEFAULT_SECTION,
  type SitemapSectionConfig,
  sectionPatterns,
  sitemapSectionIssues,
} from '@ultimat3/core';

export type SitemapSection = SitemapSectionConfig;

/** A page's path as a pattern reads it: no query, no fragment, no trailing slash. */
function segmentsOf(path: string): readonly string[] {
  const bare = path.replace(/[?#].*$/, '').replace(/\/+$/, '');
  return bare === '' ? [] : bare.slice(1).split('/');
}

function matches(pattern: string, page: readonly string[]): boolean {
  const wanted = segmentsOf(pattern);
  const subtree = wanted.at(-1) === '**';
  const fixed = subtree ? wanted.slice(0, -1) : wanted;
  // `/blog/**` is `/blog` and everything below it: a section's own landing page files with it.
  if (subtree ? page.length < fixed.length : page.length !== fixed.length) return false;
  return fixed.every((segment, index) => segment === '*' || segment === page[index]);
}

/**
 * The section `path` files under: the first one, in declaration order, with a pattern that matches
 * — else the default. `path` is UNPREFIXED, so a page and its locale copies share one file.
 */
export function sectionOf(path: string, sections: readonly SitemapSection[]): string {
  const page = segmentsOf(path);
  for (const section of sections) {
    if (sectionPatterns(section).some((pattern) => matches(pattern, page))) return section.name;
  }
  return SITEMAP_DEFAULT_SECTION;
}

/** Refuses what `defineConfig` refuses, for a caller that built the options by hand. */
export function assertSections(sections: readonly SitemapSection[], pageSize: number): void {
  const issues = sitemapSectionIssues(sections, pageSize);
  assert(
    issues.length === 0,
    issues.join('; '),
    "pass sections as [{ name: 'blog', match: '/blog/**' }] — a lower-case slug and a path pattern — and maxUrls from 1 to 50000",
  );
}
