// The route table `x dev` serves, in mount order: the dashboard, the API, the assets a document
// names, the island and sync-worker scripts, and the app's pages last. Split from `cmd-dev.ts` at its
// 500-line ceiling; `serve.ts` composes the production table from the same builders.

import type { Route } from '@ultimat3/http';
import { describeRoutes } from '@ultimat3/render';
import type { Storage } from '@ultimat3/storage';
import { apiRoutes } from './api-routes';
import { mountAppMcp } from './app-mcp';
import type { DevDashboardInput } from './dev-dashboard';
import { devDashboardRoutes } from './dev-dashboard';
import { errorPageStyleSources } from './error-page-csp';
import type { IslandBundle } from './island-bundle';
import { islandHarnessRoutes } from './island-harness-route';
import { islandRoutes } from './island-routes';
import { loadIslandStates } from './island-states-load';
import { pageSync } from './page-sync';
import { loadPwaArtifacts } from './pwa-artifacts';
import { assetRoutes } from './runtime-assets';
import { appRoutes } from './runtime-render';
import { servedStorage, storageRoutes } from './runtime-storage';
import { styleBundle } from './style-bundle';
import { styleRoutes } from './style-routes';
import { serviceWorkerArtifacts } from './sw-artifacts';
import { serviceWorkerRoutes } from './sw-routes';
import type { ThemeBoot } from './theme-boot';
import { loadThemeMode, themeBoot } from './theme-boot';

export interface DevRouteTableInput {
  readonly root: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly buildId: string;
  readonly storage: Storage;
  readonly dashboard: DevDashboardInput;
  /** A getter: the watcher tick rebuilds the islands, and a captured bundle would serve the first. */
  readonly islands: () => IslandBundle;
}

export interface DevRouteTable {
  readonly routes: readonly Route[];
  /** The theme boot, whose `cspSource` the web role admits. */
  readonly theme: ThemeBoot;
  /** The app's own error pages' inline styles, admitted the same way. */
  readonly errorStyles: readonly string[];
  /** Where the app's MCP endpoint was mounted, or `undefined`. */
  readonly mcpPath: string | null;
}

export async function devRouteTable(input: DevRouteTableInput): Promise<DevRouteTable> {
  // Resolved once, before the first route. `undefined` for an app that is not installable: nothing
  // is mounted, and the 0kb baseline is not spent on a `<link>` to a file that does not exist.
  const pwa = await loadPwaArtifacts(input.root);
  const theme = themeBoot(await loadThemeMode(input.root));
  // The same call `serve.ts` makes, so the two boots cannot serve different sync targets.
  const sync = await pageSync(input.root, input.env, input.buildId);
  const errorStyles = await errorPageStyleSources(input.root);
  // Built once at boot and NOT rebuilt with the islands on a watcher tick: a service worker that
  // changes under a page it controls is the update path, and one per keystroke exercises it per save.
  const serviceWorker =
    pwa === undefined
      ? undefined
      : serviceWorkerArtifacts({
          pwa,
          buildId: input.buildId,
          routes: describeRoutes(),
          islands: input.islands(),
          styles: styleBundle(),
          scripts: sync.scripts,
        });

  // The app's own MCP endpoint, discovered from `apps/<app>/mcp.ts` and mounted through the SAME
  // call `runRole` makes — `POST /mcp` answered 404 in every process the framework booted until
  // one of them asked. Warned once here when `expose` is true and nothing can be mounted.
  const mcpMount = await mountAppMcp(input.root);
  // `serve-boot.ts`'s answer: the app's declared disks when it has any, read per request.
  const served = servedStorage(input.storage);
  const routes: readonly Route[] = [
    ...devDashboardRoutes(input.dashboard),
    // The same API table the container serves: a read that answers here and 404s in production
    // is exactly the drift one composition exists to prevent.
    ...apiRoutes(),
    ...mcpMount.routes,
    // The image pipeline's only HTTP surface: the icons the web manifest declares, and the
    // variants every `srcset` promises. Mounted before the app's own routes so a page route can
    // never shadow `/icons` or `/media`.
    ...assetRoutes({
      root: input.root,
      storage: served,
      ...(pwa === undefined ? {} : { pwa }),
    }),
    ...storageRoutes({ storage: served }),
    // The chunks the documents below name. Mounted before the app's routes for the reason
    // `/icons` and `/media` are: a page route must not be able to shadow an asset URL.
    ...islandRoutes(() => input.islands()),
    // And the stylesheet every one of those documents links. Read through the getter for the
    // reason the islands are: a rebuilt island registers CSS, which mints a new URL, and a table
    // captured at boot would answer 404 for the href the document now carries.
    ...styleRoutes(() => styleBundle()),
    // `x shot --island`'s harness, in the `/_x` dev namespace so no app route can shadow it. It
    // lives here rather than in a second server because everything it needs is in THIS process:
    // the built chunks, the app's stylesheet registry, and the one embedded Postgres a checkout
    // may have. The states are read per REQUEST — an author editing a state and re-running the
    // command must not need a restart to see it.
    ...islandHarnessRoutes({
      islands: () => input.islands(),
      states: () => loadIslandStates(input.root),
    }),
    ...(serviceWorker === undefined ? [] : serviceWorkerRoutes(serviceWorker)),
    ...sync.routes,
    ...appRoutes({
      buildId: input.buildId,
      resolveIsland: (file) => input.islands().resolverFor(file),
      sync: sync.head,
      persisted: sync.persisted,
      themeHead: theme.head,
      ...(pwa === undefined ? {} : { pwaHead: pwa.head + (serviceWorker?.head ?? '') }),
    }),
  ];

  return { routes, theme, errorStyles, mcpPath: mcpMount.path };
}
