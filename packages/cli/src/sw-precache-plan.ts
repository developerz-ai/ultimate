// What the service worker is told about: every navigable route spelled once per routed locale, and
// the precache narrowed to the island chunks a precached page actually boots. Split from
// `sw-artifacts.ts`, which composes the worker; this file decides its inputs.

import { localeSegment, localizePath } from '@ultimat3/core';
import type { PrecacheAsset, PwaRoute } from '@ultimat3/pwa';
import { strategyFor } from '@ultimat3/pwa';
import type { RouteDescriptor } from '@ultimat3/render';
import type { IslandBundle } from './island-bundle';
import type { StyleBundle } from './style-bundle';

/**
 * One rendered document, as the precache manifest needs it.
 *
 * `revision` is `contentHash(html)` — `@ultimat3/render`'s own, the function that already stamps
 * an ETag — and never the build id. `precache.ts`' header states the rule and nothing kept it:
 * `pwaRoutes` projected four of `PwaRoute`'s eight fields, so every route entry read
 * `{"url":"/","revision":"build-aaa","bytes":0}` and two deploys of a byte-identical site
 * re-fetched every precached document. The zero was the second half — `DEFAULT_PRECACHE_WARN_BYTES`
 * is a 5 MB budget over a total that could not count one byte of HTML.
 */
export interface RenderedDocument {
  readonly revision: string;
  readonly bytes: number;
  /**
   * The same-origin scripts and island entries the document names (`measureDocumentJs`'s
   * `entries`), so a precached page's islands are precached with it and no other page's are.
   */
  readonly assets?: readonly string[];
}

/** The app's routed locales, default first — `@ultimat3/i18n`'s `routedLocales()` and fallback. */
export interface RoutedLocales {
  readonly routed: readonly string[];
  readonly fallback: string;
}

type NavigableRoute = RouteDescriptor & { readonly surface: 'site' | 'app' };

/** `api/` and `shared/` are no document a browser navigates to. */
const navigable = (route: RouteDescriptor): route is NavigableRoute =>
  route.surface === 'site' || route.surface === 'app';

const spell = (path: string, locale: string, locales: RoutedLocales): string =>
  localizePath(path, locale, locales.routed, locales.fallback);

/**
 * The route table, as the service worker sees it — once per routed locale. The server strips a
 * `/en/` prefix before it matches (`@ultimat3/http`'s `locale-prefix.ts`), and the worker matches
 * pathnames: with one spelling per route, no `/en/…` URL had a rule, so the English site was never
 * cached and never offline (notificado.co, 22.3.2). Only the fields a browser can act on cross,
 * plus — for a spelling this build rendered — the content hash and byte count of its document.
 */
export function pwaRoutes(
  routes: readonly RouteDescriptor[],
  documents: ReadonlyMap<string, RenderedDocument>,
  locales: RoutedLocales,
): readonly PwaRoute[] {
  return routes.filter(navigable).flatMap((route) =>
    locales.routed.map((locale): PwaRoute => {
      const path = spell(route.path, locale, locales);
      // A `Map`, so a route path that happens to spell a prototype member cannot answer with one.
      const document = documents.get(path);
      return {
        path,
        surface: route.surface,
        mode: route.mode,
        offline: route.offline,
        dynamic: route.dynamic,
        personal: route.personal,
        // Absent rather than invented for a route no build rendered — an `ssr` page, or one this
        // pass could not produce. `buildPrecacheManifest` then falls back to the build id.
        ...(document === undefined ? {} : { revision: document.revision, bytes: document.bytes }),
      };
    }),
  );
}

/** `['en']` for an `es-co` app routing `es-co` and `en` — the prefixes the default locale has not. */
export const localePrefixes = (locales: RoutedLocales): readonly string[] =>
  locales.routed
    .map(localeSegment)
    .filter((segment) => segment !== localeSegment(locales.fallback));

const precached = (route: PwaRoute): boolean =>
  route.offline === 'precache' && route.dynamic !== true && strategyFor(route) !== 'network-only';

export interface PrecacheAssetInput {
  readonly routes: readonly RouteDescriptor[];
  readonly documents: ReadonlyMap<string, RenderedDocument>;
  readonly locales: RoutedLocales;
  readonly islands: IslandBundle;
  readonly styles: StyleBundle;
  readonly scripts: readonly { readonly url: string; readonly bytes: number }[];
  /** The offline document's path: its islands ride the precache whatever its own route says. */
  readonly fallback: string;
}

/**
 * The island chunks a PRECACHED page boots, every surface stylesheet and every framework script.
 * Every island in the app was precached, so a first anonymous visit to a marketing page downloaded
 * the admin, KYC and payment islands too — 43 chunks, ~1 MB on notificado.co (22.3.2). The rest are
 * cached the first time a page asks for one (`ISLAND_BASE_PATH` is a runtime asset prefix).
 *
 * Two readers of "which islands", because only one of them exists per build: the static export
 * rendered the documents and knows the chunk URLs each one names; `x dev` and the container emit
 * the worker at boot, before any page has rendered, and resolve each precached route's declared
 * island `src` against its own file — `island()` is route-module-local by construction.
 *
 * Sorted by url, because `buildPrecacheManifest` sorts its own entries but the ASSET list is what
 * decides which of two equal urls wins, and `sw.js` must be byte-identical for identical input.
 */
export function precacheAssets(input: PrecacheAssetInput): readonly PrecacheAsset[] {
  const wanted = new Set<string>();
  const paths = new Set(
    pwaRoutes(input.routes, input.documents, input.locales)
      .filter(precached)
      .map((route) => route.path),
  );
  for (const locale of input.locales.routed)
    paths.add(spell(input.fallback, locale, input.locales));
  for (const path of paths) {
    for (const url of input.documents.get(path)?.assets ?? []) wanted.add(url);
  }
  for (const route of input.routes.filter(navigable)) {
    const isFallback = route.path === input.fallback;
    if (!isFallback && !precached(route)) continue;
    const resolve = input.islands.resolverFor(route.file);
    for (const src of route.islandSources) {
      try {
        wanted.add(resolve(src));
      } catch {
        // A src the bundle cannot resolve fails the RENDER that names it, with its own finding;
        // here it only means there is no chunk to precache.
      }
    }
  }
  return [
    ...input.islands.chunks.filter((chunk) => wanted.has(chunk.url)),
    ...input.styles.chunks,
    ...input.scripts,
  ]
    .map((chunk) => ({ url: chunk.url, revision: chunk.url, bytes: chunk.bytes }))
    .sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0));
}
