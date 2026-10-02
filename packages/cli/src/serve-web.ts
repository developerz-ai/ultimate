// What only the web role serves: its islands, its documents and every route beside them. A file
// of its own so the roles that render nothing never import it — `serve-boot.ts` loads it with
// `await import()` for `ROLE=web` alone, and `serve-graph.test.ts` pins what every other role is
// spared: render's server half, the PWA, SEO, MCP and island subsystems.

import type { Route } from '@ultimat3/http';
import { describeRoutes } from '@ultimat3/render';
import { createIsrController } from '@ultimat3/render/server';
import { apiMountRoutes, apiRoutes, pagePostRoutes } from './api-routes';
import { loadSignInPath } from './app-auth';
import { mountAppMcp } from './app-mcp';
import { errorPageStyleSources } from './error-page-csp';
import { islandRoutes } from './island-routes';
import type { LoadedIslands } from './island-store';
import { loadOrBuildIslands } from './island-store';
import { loadNavigation, pageNavigation } from './page-navigation';
import { loadSpeculation, pageSpeculation } from './page-speculation';
import { pageSync } from './page-sync';
import { loadPwaArtifacts } from './pwa-artifacts';
import { adminMountRoutes } from './runtime-admin';
import { assetRoutes } from './runtime-assets';
import { appRoutes } from './runtime-render';
import type { RunningServices } from './runtime-services';
import { servedStorage, storageRoutes } from './runtime-storage';
import { seoRoutes } from './seo-routes';
import type { ServeOptions } from './serve-types';
import { loadSiteSettings, publicOrigin } from './site-config';
import { styleBundle } from './style-bundle';
import { styleRoutes } from './style-routes';
import { serviceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerRoutes } from './sw-routes';
import { loadThemeMode, themeBoot } from './theme-boot';

/** Everything `startRoles` is handed that only a process serving documents has. */
export interface WebSurface {
  readonly routes: readonly Route[];
  /** The theme boot and the speculation rules: the two inline bodies every document may carry. */
  readonly inlineScripts: readonly string[];
  /** The app's own error pages' `<style>` bodies, which the enforced policy must admit. */
  readonly inlineStyles: readonly string[];
  /** Where a browser that opened a guarded page is sent — the declaration `x dev` reads. */
  readonly signInPath: string | null;
  /** Present when this boot built the islands itself: how many chunks, and why not the store. */
  readonly islandsBuilt?: LoadedIslands['built'];
}

export async function webSurface(
  options: ServeOptions,
  runtime: RunningServices,
  buildId: string,
): Promise<WebSurface> {
  // Read from the store the image build wrote and VERIFIED against this app and this runtime
  // (`island-store.ts`); built here only when there is no store to trust, which is correct and
  // slower — the reason travels back to the boot, which reports it.
  const { bundle: islands, built: islandsBuilt } = await loadOrBuildIslands(options.root);
  // The same two strings `x dev` resolves, from the same reader: a `<link rel="manifest">` served
  // on a laptop and absent in the image is exactly the dev/prod difference this file exists to
  // prevent, and it is the one an operator cannot see without installing the app.
  const pwa = await loadPwaArtifacts(options.root);
  const theme = themeBoot(await loadThemeMode(options.root));
  // `site.origin` and `seo.robots.disallow`: the absolute URLs every document and the sitemap carry.
  const site = await loadSiteSettings(options.root);
  const origin = publicOrigin(options.env, site);
  // The page's sync target and its scripts — the same call `x dev` makes, so the two cannot differ.
  // Before the service worker, which precaches those scripts.
  const sync = await pageSync(options.root, options.env, buildId, runtime.realtime);
  // The client router, when a surface opted in (`navigation.client`) — the same call in both boots.
  const declared = await loadNavigation(options.root);
  const navigation = await pageNavigation(options.root, declared, buildId);
  // The browser's own prefetch, for the documents that carry no router (`navigation.speculation`).
  const speculation = pageSpeculation({
    config: await loadSpeculation(options.root),
    client: declared.surfaces,
  });
  // The worker, from the SAME route table this process is about to serve — `describeRoutes()` is
  // the one projection `x.manifest.json`, `/_x`, the sitemap and `sw.js` are all built from, so a
  // route added here cannot be missing from the precache manifest.
  const serviceWorker =
    pwa === undefined
      ? undefined
      : serviceWorkerArtifacts({
          pwa,
          buildId,
          routes: describeRoutes(),
          islands,
          styles: styleBundle(),
          scripts: [
            ...sync.scripts,
            ...(navigation.script === undefined ? [] : [navigation.script]),
          ],
        });
  // The app's own MCP endpoint, through the same call `x dev` makes — see `app-mcp.ts`.
  const mcpMount = await mountAppMcp(options.root);
  // The app's own disks when it declared any (`defineStorage` in an app module), else this boot's.
  const served = servedStorage(runtime.storage);
  const routes: readonly Route[] = [
    ...apiRoutes(),
    // The bearer doors onto a cut of the same routes (`defineApi({ http: { mounts } })`), counted
    // on the store this boot's limiter uses, so one token's allowance is one number fleet-wide.
    ...apiMountRoutes(options.runtime?.rateLimitStore ?? runtime.rateLimitStore),
    ...mcpMount.routes,
    // The app's own plain routes (`apps/<app>/runtime.ts` `routes`), before any page can shadow one.
    ...(options.runtime?.routes ?? []),
    ...(serviceWorker === undefined ? [] : serviceWorkerRoutes(serviceWorker)),
    ...assetRoutes({
      root: options.root,
      storage: served,
      ...(options.runtime?.images === undefined ? {} : { images: options.runtime.images }),
      ...(pwa === undefined ? {} : { pwa }),
    }),
    ...storageRoutes({ storage: served }),
    ...islandRoutes(() => islands),
    // The surface stylesheets the documents link. Built from the registry the `loadApp` above
    // filled, so this process serves exactly the CSS it renders against.
    ...styleRoutes(() => styleBundle()),
    // `robots.txt` and `sitemap.xml`, the same two files the static export writes (`site-seo.ts`).
    ...seoRoutes({ env: options.env, site, root: options.root }),
    // The page's one socket: its worker script, served beside the islands for their reason.
    ...sync.routes,
    ...navigation.routes,
    // A page's `POST`, bound to an action (`defineRoute({ post })`) — beside the page's `GET`.
    ...pagePostRoutes(),
    // The app's generated admin, when it declared one (`defineAdmin`): every screen under its base
    // path, served through the same document builder as the pages below. Nothing for an app with
    // no admin — the registry is asked, the package is not imported.
    ...adminMountRoutes({
      buildId: buildId,
      themeHead: theme.head,
      ...(origin === undefined ? {} : { origin }),
    }),
    ...appRoutes({
      buildId,
      resolveIsland: (file) => islands.resolverFor(file),
      ...(sync.head === undefined ? {} : { sync: sync.head }),
      persisted: sync.persisted,
      ...(navigation.head === undefined ? {} : { navigation: navigation.head }),
      themeHead: theme.head,
      ...(speculation === undefined ? {} : { speculationHead: speculation.head }),
      // A `static` page is the same bytes for every request of this process: rendered once.
      memoStatic: true,
      ...(origin === undefined ? {} : { origin }),
      ...(pwa === undefined
        ? {}
        : { pwaHead: (locale: string) => pwa.headFor(locale) + (serviceWorker?.head ?? '') }),
      // Only when a store was supplied. `createIsrController` defaults to a per-process memory
      // store, so twelve replicas hold twelve of them and a purge tag regenerates one twelfth of
      // the fleet while the other eleven keep serving the page it just invalidated.
      ...(options.runtime?.isrStore === undefined
        ? {}
        : { isr: createIsrController({ buildId, store: options.runtime.isrStore }) }),
    }),
  ];
  return {
    routes,
    inlineScripts: [theme.cspSource, ...(speculation === undefined ? [] : [speculation.cspSource])],
    // The enforced policy this process sends must admit the app's own error pages' `<style>` and
    // the theme boot the documents carry; `x dev` is report-only, so only here was it a blank page.
    inlineStyles: await errorPageStyleSources(options.root),
    // Same declaration `x dev` reads. Without it a container answers a browser that opened a
    // guarded page with the problem document, rendered as raw JSON in the viewport.
    signInPath: await loadSignInPath(options.root),
    ...(islandsBuilt === undefined ? {} : { islandsBuilt }),
  };
}
