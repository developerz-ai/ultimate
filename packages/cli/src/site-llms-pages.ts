// `/llms.txt`'s per-page reads: every page of a public `site/` route whose `meta` needs its `load`
// (or its params), titled by that `meta`. Collected by the static export INSIDE its API scope, so
// `siteLlms` never runs a page's `load` after the build stopped answering the app's own queries.

import type { Environment } from '@ultimat3/core';
import { ctxOf, DEFAULT_ENVIRONMENT, runWithContext, tryResolveEnvironment } from '@ultimat3/core';
import type { PrerenderEntry, RouteEntry } from '@ultimat3/render';
import { metaContextFor, routeDataFor, routeEntries } from '@ultimat3/render';
import { enumeratePrerenderEntries, fillPath } from '@ultimat3/render/server';
import type { RouteRecord } from '@ultimat3/seo';
import { isIndexable } from '@ultimat3/seo';
import type { RouteEntries } from './prerender-entries';
import { readSiteMeta } from './seo-meta';

/** Each route's page records, by DECLARED path (`/posts/:slug`) — what `siteLlms` reads first. */
export type LlmsPages = ReadonlyMap<string, readonly RouteRecord[]>;

export type Enumerate = (entry: RouteEntry) => Promise<readonly PrerenderEntry[]>;

export interface LlmsPageOptions {
  readonly baseUrl: string;
  /** The app's default locale: every `meta` runs in it. */
  readonly defaultLocale: string;
  /** The build's own enumeration (`PrerenderReport.entries`), so `prerender()` is asked once. */
  readonly enumerate?: Enumerate | undefined;
}

/** A `site/` page anyone may fetch — `site-seo.ts`' own rule. */
const isPublicSite = (entry: RouteEntry): boolean =>
  entry.surface === 'site' && entry.config.policy === undefined;

/** `llms.txt`'s routes: those whose `meta` resolves without a request, and those that need `load`. */
export interface LlmsRoutes {
  readonly resolved: readonly RouteRecord[];
  readonly loaded: readonly RouteEntry[];
}

/**
 * The public `site/` routes, split once: `resolved` answered by `readSiteMeta` (no `load`, no
 * params), `loaded` the rest, which `pageRecords` reads page by page.
 */
export async function llmsRoutes(defaultLocale: string): Promise<LlmsRoutes> {
  const entries = routeEntries().filter(isPublicSite);
  const publicPaths = new Set(entries.map((entry) => entry.path));
  const resolved = (await readSiteMeta(defaultLocale)).records.filter((record) =>
    publicPaths.has(record.path),
  );
  const resolvedPaths = new Set(resolved.map((record) => record.path));
  return { resolved, loaded: entries.filter((entry) => !resolvedPaths.has(entry.path)) };
}

/**
 * One record per page `prerender()` enumerates, with the `meta` its own `load` feeds, run in the
 * default locale with no actor: the prerender's context.
 */
export async function pageRecords(
  entry: RouteEntry,
  options: LlmsPageOptions,
): Promise<readonly RouteRecord[]> {
  const records: RouteRecord[] = [];
  for (const page of await (options.enumerate ?? enumeratePrerenderEntries)(entry)) {
    const path = fillPath(entry.pattern.source, page.params);
    const ctx = { url: `${options.baseUrl.replace(/\/+$/, '')}${path}`, params: page.params };
    const meta = await runWithContext(
      ctxOf({ role: 'web', locale: options.defaultLocale }),
      async () => entry.config.meta(metaContextFor(ctx, await routeDataFor(entry.config, ctx))),
    );
    records.push({ path, file: entry.file, surface: 'site', render: entry.config.render, meta });
  }
  return records;
}

export interface CollectLlmsPagesOptions extends Omit<LlmsPageOptions, 'enumerate'> {
  /** The build's own `prerender()` answers (`enumerateRoutes`): a route listed is never asked again. */
  readonly entries?: RouteEntries | undefined;
  readonly environment?: Environment | undefined;
  /** `seo.llms`; `false` collects nothing. */
  readonly enabled?: boolean | undefined;
  /** The build's API scope: every `load` runs inside it, where the app's own queries answer. */
  readonly scope: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Before the first `load`: the build starts its database here, and only when one is needed. */
  readonly before?: (() => Promise<void>) | undefined;
}

/**
 * Every page record `siteLlms` would read through a `load`, read now, inside `scope`. Nothing
 * outside production or under `seo.llms: false` — `siteLlms` answers empty there, so a staging
 * build reads no row for a document it throws away. A throw is the build's failure: a `load` that
 * cannot answer is the app's bug, never a page silently left out.
 */
export async function collectLlmsPages(options: CollectLlmsPagesOptions): Promise<LlmsPages> {
  const environment = options.environment ?? tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
  const pages = new Map<string, readonly RouteRecord[]>();
  if (options.enabled === false || !isIndexable(environment)) return pages;
  const routes = (await llmsRoutes(options.defaultLocale)).loaded;
  if (routes.length === 0) return pages;
  await options.before?.();
  const enumerate: Enumerate = (route) => {
    const listed = options.entries?.get(route.path);
    return listed === undefined ? enumeratePrerenderEntries(route) : Promise.resolve(listed);
  };
  for (const entry of routes) {
    pages.set(entry.path, await options.scope(() => pageRecords(entry, { ...options, enumerate })));
  }
  return pages;
}
