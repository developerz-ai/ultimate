// Single responsibility: `/llms.txt` — the site's public pages, by title and description, for a
// language model — built from the same route records the sitemap reads. One answer, served by a
// running web role and written by the static export alike, and empty outside production for
// `robots.txt`'s reason: a branch deploy must not be what a model learns the site from.

import type { Environment } from '@ultimat3/core';
import { DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { SEO_ERROR_CODES } from './errors';
import { isIndexable } from './robots';
import type { RouteRecord } from './routes';
import { isDynamic } from './routes';
import type { MetaIssue } from './validate';
import { absoluteUrl } from './xml';

export const LLMS_PATH = '/llms.txt';

export interface LlmsSite {
  readonly baseUrl: string;
  /** Omitted: `ULTIMATE_ENV`. Anything but `production` answers an empty document. */
  readonly environment?: Environment | undefined;
  /** `seo.llms` — `false` answers an empty document everywhere. */
  readonly enabled?: boolean | undefined;
}

/** A listed page: an indexable `site/` route whose meta resolved without a request. */
const listed = (route: RouteRecord): boolean =>
  route.surface === 'site' &&
  route.noindex !== true &&
  route.meta?.robots?.index !== false &&
  route.meta?.title !== undefined &&
  !isDynamic(route.path);

/** One line, so a newline in a title cannot open a second Markdown entry. */
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
const linkText = (text: string): string => oneLine(text).replace(/[[\]]/g, '\\$&');

/**
 * `# <home title>`, `> <home description>`, then `- [title](url): description` per listed page,
 * in path order. The home page names the site: no second site name to keep in step with its title.
 */
export function buildLlmsTxt(routes: readonly RouteRecord[], site: LlmsSite): string {
  const environment = site.environment ?? tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
  if (site.enabled === false || !isIndexable(environment)) return '';
  const pages = routes
    .filter(listed)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const home = pages.find((route) => route.path === '/');
  const lines = [`# ${oneLine(home?.meta?.title ?? site.baseUrl)}`, ''];
  const summary = home?.meta?.description;
  if (summary !== undefined) lines.push(`> ${oneLine(summary)}`, '');
  for (const route of pages) {
    const description = route.meta?.description;
    const link = `- [${linkText(route.meta?.title ?? route.path)}](${absoluteUrl(site.baseUrl, route.path)})`;
    lines.push(description === undefined ? link : `${link}: ${oneLine(description)}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The convention's build error: every page `/llms.txt` lists says what it is. The `seo` step asks
 * only while `seo.llms` is on; a page with no description is a line that tells a model nothing.
 * `validateMeta`'s issue shape, so the step reports both through one projection.
 */
export function llmsDescriptionIssues(routes: readonly RouteRecord[]): readonly MetaIssue[] {
  return routes
    .filter((route) => listed(route) && route.meta?.description === undefined)
    .map((route) => ({
      code: SEO_ERROR_CODES.llmsDescriptionMissing,
      route: route.path,
      file: route.file,
      cause: `${route.file} (route "${route.path}") is listed in /llms.txt and has no meta.description, so its line says nothing about the page`,
      fix: `x verify --only seo --json   # then add description to defineRoute({ meta }) in ${route.file}, or set seo: { llms: false } in app.config.ts`,
    }));
}
