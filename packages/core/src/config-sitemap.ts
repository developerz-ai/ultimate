// Single responsibility: `seo.sitemap.sections` and `seo.sitemap.pageSize` — the shape of a named
// sitemap section and the one validator both `defineConfig` and `@ultimat3/seo` refuse it with.
// Split from `config-site.ts`: that file owns the origin and the crawler rules.

import { describeValue } from './error-render';

/**
 * One named part of a sitemap index. Every listed page whose UNPREFIXED path matches goes to
 * `/sitemaps/<name>-<n>.xml`; the first section that matches wins, in declaration order.
 */
export interface SitemapSectionConfig {
  /** Lower-case slug — it is a file name: `blog` → `/sitemaps/blog-1.xml`. */
  readonly name: string;
  /**
   * A path pattern, or several: `/precios` (that page), `/blog/*` (one segment below), `/blog/**`
   * (`/blog` and everything below it). Matched against the page's path without its locale prefix,
   * so `/en/blog/a` files with `/blog/a`.
   */
  readonly match: string | readonly string[];
}

/** Where a page no section matches goes. Reserved: an app's section may not take the name. */
export const SITEMAP_DEFAULT_SECTION = 'pages';

/** The sitemaps.org cap on `<url>` entries in one file — the default and the ceiling of `pageSize`. */
export const SITEMAP_PAGE_SIZE_MAX = 50_000;

const SECTION_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SECTION_NAME_MAX = 64;

/** The patterns of one section as a list, whichever form it was written in. */
export function sectionPatterns(section: SitemapSectionConfig): readonly string[] {
  return typeof section.match === 'string' ? [section.match] : section.match;
}

function patternIssue(pattern: string): string | undefined {
  if (!pattern.startsWith('/') || pattern.startsWith('//') || /[?#]/.test(pattern)) {
    return 'must be a path starting with / — no origin, query or fragment';
  }
  const segments = pattern.split('/').slice(1);
  for (const [index, segment] of segments.entries()) {
    if (segment === '**' && index !== segments.length - 1) {
      return 'may use ** only as its last segment';
    }
    if (segment !== '*' && segment !== '**' && segment.includes('*')) {
      return 'may use * only as a whole segment';
    }
  }
  return undefined;
}

/**
 * Every refusal `sections` and `pageSize` earn, as sentences. `unknown` in: an untyped config
 * reaches here with whatever it wrote, and a validator that throws natively names nothing.
 */
export function sitemapSectionIssues(sections: unknown, pageSize: unknown): readonly string[] {
  const issues: string[] = [];
  if (
    typeof pageSize !== 'number' ||
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > SITEMAP_PAGE_SIZE_MAX
  ) {
    issues.push(
      `seo.sitemap.pageSize must be a whole number from 1 to ${String(SITEMAP_PAGE_SIZE_MAX)} (the sitemaps.org cap), not ${describeValue(pageSize)}`,
    );
  }
  if (!Array.isArray(sections)) {
    issues.push(
      `seo.sitemap.sections must be a list of { name, match }, not ${describeValue(sections)}`,
    );
    return issues;
  }
  const seen = new Set<string>();
  for (const section of sections as readonly unknown[]) {
    if (typeof section !== 'object' || section === null || Array.isArray(section)) {
      issues.push(
        `seo.sitemap.sections entry must be { name, match }, not ${describeValue(section)}`,
      );
      continue;
    }
    const { name, match } = section as { readonly name?: unknown; readonly match?: unknown };
    if (typeof name !== 'string' || !SECTION_NAME.test(name) || name.length > SECTION_NAME_MAX) {
      issues.push(
        `seo.sitemap.sections name ${describeValue(name)} must be a lower-case slug (a-z, 0-9, single hyphens, at most ${String(SECTION_NAME_MAX)} characters) — it becomes the file name /sitemaps/<name>-<n>.xml`,
      );
    } else if (name === SITEMAP_DEFAULT_SECTION) {
      issues.push(
        `seo.sitemap.sections name "${name}" is reserved for the pages no section matches`,
      );
    } else if (seen.has(name)) {
      issues.push(`seo.sitemap.sections names "${name}" twice — two sections would write one file`);
    } else {
      seen.add(name);
    }
    const label = typeof name === 'string' ? `"${name}"` : 'entry';
    const patterns = typeof match === 'string' ? [match] : match;
    if (!Array.isArray(patterns) || patterns.length === 0) {
      issues.push(
        `seo.sitemap.sections ${label} match must be a path pattern or a non-empty list of them, not ${describeValue(match)}`,
      );
      continue;
    }
    for (const pattern of patterns as readonly unknown[]) {
      if (typeof pattern !== 'string') {
        issues.push(
          `seo.sitemap.sections ${label} match entry must be a path pattern string, not ${describeValue(pattern)}`,
        );
        continue;
      }
      const issue = patternIssue(pattern);
      if (issue !== undefined) {
        issues.push(`seo.sitemap.sections ${label} match "${pattern}" ${issue}`);
      }
    }
  }
  return issues;
}
