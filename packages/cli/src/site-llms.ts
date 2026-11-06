// `/llms.txt`'s pages, off the route table: every public `site/` page in the default locale by the
// title and description its own `meta` gives it. A dynamic route (or one with a `load`) is expanded
// through `prerender()` and its `load`, page by page, exactly as the static export renders it.

import type { Environment } from '@ultimat3/core';
import { ctxOf, DEFAULT_ENVIRONMENT, runWithContext, tryResolveEnvironment } from '@ultimat3/core';
import { unlocalizedPath } from '@ultimat3/i18n';
import type { PrerenderEntry, RouteEntry } from '@ultimat3/render';
import { metaContextFor, routeDataFor, routeEntries } from '@ultimat3/render';
import { enumeratePrerenderEntries, fillPath } from '@ultimat3/render/server';
import type { RouteRecord } from '@ultimat3/seo';
import { buildLlmsTxt, disallowMatcher, isDynamic, isIndexable } from '@ultimat3/seo';
import { readSiteMeta } from './seo-meta';

export interface SiteLlmsOptions {
  readonly baseUrl: string;
  readonly environment?: Environment | undefined;
  /** `seo.llms`; `false` answers an empty document. */
  readonly enabled?: boolean | undefined;
  readonly disallow?: readonly string[] | undefined;
  /** The static export's emitted pages per route, as the sitemap reads them (`SiteSeoOptions`). */
  readonly pagesFor?: ((routePath: string) => readonly string[]) | undefined;
  /** The app's default locale: every `meta` runs in it, and its paths are unprefixed. */
  readonly defaultLocale: string;
  /** `siteSeo`'s one enumeration per route, so the sitemap and this file never call `prerender()` twice. */
  readonly enumerate?: ((entry: RouteEntry) => Promise<readonly PrerenderEntry[]>) | undefined;
}

/** A `site/` page anyone may fetch — `site-seo.ts`' own rule. */
const isPublicSite = (entry: RouteEntry): boolean =>
  entry.surface === 'site' && entry.config.policy === undefined;

/**
 * Empty outside production and under `seo.llms: false` BEFORE any `prerender()` or `load` runs: a
 * staging web role must not read every post to answer a document it then throws away.
 */
export async function siteLlms(options: SiteLlmsOptions): Promise<string> {
  const environment = options.environment ?? tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
  if (options.enabled === false || !isIndexable(environment)) return '';
  const disallowed = disallowMatcher(options.disallow ?? []);
  const entries = routeEntries().filter(isPublicSite);
  const resolved = (await readSiteMeta(options.defaultLocale)).records;
  const resolvedPaths = new Set(resolved.map((record) => record.path));
  const publicPaths = new Set(entries.map((entry) => entry.path));
  const expanded: RouteRecord[] = [];
  for (const entry of entries) {
    if (resolvedPaths.has(entry.path)) continue;
    expanded.push(...(await pageRecords(entry, options)));
  }
  const records = [
    ...resolved.filter((record) => publicPaths.has(record.path)),
    ...expanded,
  ].filter((record) => !disallowed(record.path));
  return buildLlmsTxt(records, { baseUrl: options.baseUrl, environment });
}

/**
 * One record per page `prerender()` enumerates — of those the export emitted, when it says — with
 * the `meta` its own `load` feeds, run in the default locale with no actor: the prerender's context.
 */
async function pageRecords(
  entry: RouteEntry,
  options: SiteLlmsOptions,
): Promise<readonly RouteRecord[]> {
  const emitted =
    options.pagesFor === undefined || !isDynamic(entry.path)
      ? undefined
      : new Set(options.pagesFor(entry.path).map((path) => unlocalizedPath(path)));
  const records: RouteRecord[] = [];
  for (const page of await (options.enumerate ?? enumeratePrerenderEntries)(entry)) {
    const path = fillPath(entry.pattern.source, page.params);
    if (emitted !== undefined && !emitted.has(path)) continue;
    const ctx = { url: `${options.baseUrl.replace(/\/+$/, '')}${path}`, params: page.params };
    const meta = await runWithContext(
      ctxOf({ role: 'web', locale: options.defaultLocale }),
      async () => entry.config.meta(metaContextFor(ctx, await routeDataFor(entry.config, ctx))),
    );
    records.push({ path, file: entry.file, surface: 'site', render: entry.config.render, meta });
  }
  return records;
}
