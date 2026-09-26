// The web and background roles' boot, after the services are up: the app loaded, its route table
// built, the roles started. Split from `serve.ts` (the entry points) at its line ceiling; the rules
// that file's header states — the SAME boot `x dev` runs, minus the watcher, `/_x` and `dev: true`
// — are this file's.

import type { Role } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { describeRoutes } from '@ultimat3/render';
import { createIsrController } from '@ultimat3/render/server';
import { apiRoutes } from './api-routes';
import { loadSignInPath } from './app-auth';
import { loadApp } from './app-load';
import { appManifest } from './app-manifest';
import { mountAppMcp } from './app-mcp';
import { errorPageStyleSources } from './error-page-csp';
import { islandRoutes } from './island-routes';
import { loadOrBuildIslands } from './island-store';
import type { MetricsEndpoint } from './metrics-endpoint';
import { startOtlpExport } from './otlp-export';
import { pageSync } from './page-sync';
import { loadPwaArtifacts } from './pwa-artifacts';
import { startRoles } from './role-start';
import { assetRoutes } from './runtime-assets';
import { appRoutes } from './runtime-render';
import { replicaOverrides } from './runtime-replica';
import type { RunningServices } from './runtime-services';
import { servedStorage, storageRoutes } from './runtime-storage';
import { seoRoutes } from './seo-routes';
import { loadDrainConfig } from './serve-drain';
import { configureReporting, containerBinding, metricsPortFor, portFromEnv } from './serve-env';
import type { ServedApp, ServeOptions } from './serve-types';
import { loadSiteSettings, publicOrigin } from './site-config';
import { styleBundle } from './style-bundle';
import { styleRoutes } from './style-routes';
import { serviceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerRoutes } from './sw-routes';
import { loadThemeMode, themeBoot } from './theme-boot';

/** The half of `serveApp` whose every acquisition is registered for rollback. */
export async function bootRoles(boot: {
  readonly options: ServeOptions;
  readonly role: Role;
  readonly runtime: RunningServices;
  readonly acquired: (() => void | Promise<void>)[];
  /** The scrape listener `serveApp` opened before any of this work; `startRoles` adopts it. */
  readonly metrics: MetricsEndpoint;
}): Promise<ServedApp> {
  const { options, role, runtime, acquired, metrics } = boot;
  // Importing the app's modules IS the registration: every route, action and job below is
  // whatever this call put in the registries.
  await loadApp(options.root);
  // The build stamps `BUILD_ID` into the image; unstamped, the manifest's content hash is the same
  // answer computed here, so `x-ultimate-build` is never absent and never a lie. Projected only
  // when unstamped, because a stamped image already paid for it at build time and a replica's boot
  // should not repeat it — the load above is the part every boot needs either way.
  const stamped = options.env['BUILD_ID'];
  const buildId =
    stamped !== undefined && stamped.length > 0
      ? stamped
      : (await appManifest(options.root)).manifest.buildId;
  // Before the first socket opens: everything above this line fails loudly into the container's
  // own logs, everything below it is a served request, a claimed job or a routed frame.
  configureReporting(options.env, buildId);
  // Beside error reporting, and for the same reason it is here: `OTEL_EXPORTER_OTLP_ENDPOINT` is
  // in the shipped chart and nothing read it, so every deployment that configured a collector got
  // an empty dashboard. `x dev` keeps its own recorder — the `/_x` timeline is a different sink
  // with a different lifetime — so this is the production boot's alone (axiom 6).
  const stopOtlp = startOtlpExport(options.env);
  acquired.push(stopOtlp);
  // Only the web role serves pages, so only it builds islands and assembles a route table: a
  // worker, scheduler, sync or replicator pod compiled every island of the app on every boot for
  // nothing it would ever serve (plan 101, slice 12 e).
  const web = role === 'web' ? await webSurface(options, runtime, buildId) : undefined;
  const port = options.port ?? portFromEnv(options.env);
  // An in-process caller asking for an ephemeral app port is a test, and a test that grabbed the
  // fixed 9090 would fail the next suite to boot beside it. An environment that names the port
  // still wins — that is the deploy talking.
  const metricsPort = metricsPortFor(options.env, port, options.metricsPort);
  const drain = await loadDrainConfig(options.root);
  const replicaOverride = replicaOverrides(options.runtime, runtime.services.db, options.env);
  const running = await startRoles({
    roles: [role],
    port,
    metricsPort,
    metrics,
    buildId,
    runtime,
    routes: web?.routes ?? [],
    env: options.env,
    // Same declaration `x dev` reads. Without it a container answers a browser that opened a
    // guarded page with the problem document, rendered as raw JSON in the viewport.
    signInPath: await loadSignInPath(options.root),
    // The enforced policy this process sends must admit the app's own error pages' `<style>` and
    // the theme boot the documents carry; `x dev` is report-only, so only here was it a blank page.
    inlineStyles: web === undefined ? [] : await errorPageStyleSources(options.root),
    inlineScripts: web === undefined ? [] : [web.themeCsp],
    // The app's own `apps/web/site/errors/<status>.html`, resolved inside `startWeb` so this
    // process and `x dev` cannot answer a browser differently.
    root: options.root,
    http: containerBinding(options.env, options.hostname),
    // `app.config.ts`'s drain section: the readiness grace the chart's grace period is sized for.
    ...(drain === undefined ? {} : { drain }),
    // The read-replica scope rides in FRONT of whatever the host supplied, or the host's own value
    // passes through untouched. `DATABASE_REPLICA_URL` was read by no booted process before this:
    // `defaultClient()` is the one composer of a replicated pair and it runs only when an app
    // installed no client, which no framework boot leaves true (`runtime-queue.ts`).
    ...(replicaOverride === undefined ? {} : { overrides: replicaOverride }),
  });
  acquired.push(() => running.stop());
  return {
    kind: 'served',
    role,
    url: running.url,
    buildId,
    running,
    runtime,
    async stop() {
      await running.stop();
      await runtime.stop();
      // Last: the exporters outlive the roles they were recording, so the drain's own spans and
      // the final counter snapshot still have somewhere to go.
      stopOtlp();
    },
  };
}

/** What only the web role serves: its islands, its documents and every route beside them. */
async function webSurface(
  options: ServeOptions,
  runtime: RunningServices,
  buildId: string,
): Promise<{ readonly routes: readonly Route[]; readonly themeCsp: string }> {
  // Read from the store `x build --target docker` wrote and VERIFIED against this app and this
  // runtime (`island-store.ts`); built here only when there is no store to trust, which is correct
  // and slower, and logged with its reason.
  const islands = await loadOrBuildIslands(options.root);
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
          scripts: sync.scripts,
        });
  // The app's own MCP endpoint, through the same call `x dev` makes — see `app-mcp.ts`.
  const mcpMount = await mountAppMcp(options.root);
  // The app's own disks when it declared any (`defineStorage` in an app module), else this boot's.
  const served = servedStorage(runtime.storage);
  const routes: readonly Route[] = [
    ...apiRoutes(),
    ...mcpMount.routes,
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
    ...seoRoutes({ env: options.env, site }),
    // The page's one socket: its worker script, served beside the islands for their reason.
    ...sync.routes,
    ...appRoutes({
      buildId,
      resolveIsland: (file) => islands.resolverFor(file),
      ...(sync.head === undefined ? {} : { sync: sync.head }),
      persisted: sync.persisted,
      themeHead: theme.head,
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
  return { routes, themeCsp: theme.cspSource };
}
