// What `siteSeo` needs from the static build, read while its API scope and database are still open:
// each `site/` route's `prerender()` entries and each `llms.txt` page's `load`. Asked after the
// scope closes, a route that reads the app's own query fails the export.

import { routeEntries } from '@ultimat3/render';
import { type EnumerateRoute, enumerateRoutes, type RouteEntries } from './prerender-entries';
import { loadSiteSettings } from './site-config';
import { collectLlmsPages, type LlmsPages } from './site-llms-pages';

export interface SeoReadsInput {
  readonly root: string;
  readonly origin: string;
  readonly defaultLocale: string;
  /** Runs one read inside the build's measurement scope. */
  readonly scope: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Readies the build's database before the first read that needs it. */
  readonly before: () => Promise<void>;
  /** The build's one enumeration memo, so a route's `prerender()` runs once per build. */
  readonly enumerate: EnumerateRoute;
}

export interface SeoReads {
  readonly entries: RouteEntries;
  readonly llmsPages: LlmsPages;
}

export async function collectSeoReads(input: SeoReadsInput): Promise<SeoReads> {
  const entries = await enumerateRoutes(routeEntries(), input.scope, input.before, input.enumerate);
  const llmsPages = await collectLlmsPages({
    baseUrl: input.origin,
    defaultLocale: input.defaultLocale,
    enabled: (await loadSiteSettings(input.root)).llms,
    entries,
    scope: input.scope,
    before: input.before,
  });
  return { entries, llmsPages };
}
