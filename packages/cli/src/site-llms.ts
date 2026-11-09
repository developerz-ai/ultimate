// `/llms.txt`'s pages, off the route table: every public `site/` page in the default locale by the
// title and description its own `meta` gives it. A dynamic route (or one with a `load`) is expanded
// through `prerender()` and its `load`, page by page, exactly as the static export renders it — or
// read off what the export already collected inside its API scope (`site-llms-pages.ts`).

import type { Environment } from '@ultimat3/core';
import { DEFAULT_ENVIRONMENT, tryResolveEnvironment } from '@ultimat3/core';
import { unlocalizedPath } from '@ultimat3/i18n';
import type { RouteRecord } from '@ultimat3/seo';
import { buildLlmsTxt, disallowMatcher, isDynamic, isIndexable } from '@ultimat3/seo';
import type { Enumerate, LlmsPages } from './site-llms-pages';
import { llmsRoutes, pageRecords } from './site-llms-pages';

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
  readonly enumerate?: Enumerate | undefined;
  /**
   * What the static export read inside its API scope (`collectLlmsPages`), by declared route path.
   * A route listed here never runs its `load` again: by the time `llms.txt` is written the build's
   * scope is gone, and a `load` reading the app's own query failed the export
   * (`X_CLIENT_TRANSPORT_FAILED`).
   */
  readonly pages?: LlmsPages | undefined;
}

/**
 * Empty outside production and under `seo.llms: false` BEFORE any `prerender()` or `load` runs: a
 * staging web role must not read every post to answer a document it then throws away.
 */
export async function siteLlms(options: SiteLlmsOptions): Promise<string> {
  const environment = options.environment ?? tryResolveEnvironment() ?? DEFAULT_ENVIRONMENT;
  if (options.enabled === false || !isIndexable(environment)) return '';
  const disallowed = disallowMatcher(options.disallow ?? []);
  const { resolved, loaded } = await llmsRoutes(options.defaultLocale);
  const expanded: RouteRecord[] = [];
  for (const entry of loaded) {
    const records = options.pages?.get(entry.path) ?? (await pageRecords(entry, options));
    expanded.push(...emittedOnly(entry.path, records, options));
  }
  return buildLlmsTxt(
    [...resolved, ...expanded].filter((record) => !disallowed(record.path)),
    { baseUrl: options.baseUrl, environment },
  );
}

/** A dynamic route's pages, less those the export did not emit — the sitemap's own rule. */
function emittedOnly(
  routePath: string,
  records: readonly RouteRecord[],
  options: SiteLlmsOptions,
): readonly RouteRecord[] {
  if (options.pagesFor === undefined || !isDynamic(routePath)) return records;
  const emitted = new Set(options.pagesFor(routePath).map((path) => unlocalizedPath(path)));
  return records.filter((record) => emitted.has(record.path));
}
