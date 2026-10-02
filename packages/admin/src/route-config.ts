// The one bridge from the admin's route table to @ultimat3/render's: the `defineRoute` config
// every admin route is served under, and the declaration that puts those routes in the framework's
// one route list. No screen is reached from here, so `defineAdmin()` can declare its routes
// without loading a view — `routes.ts` binds each route to its screen.

import { t } from '@ultimat3/i18n';
import {
  defineRoute,
  type RouteConfig,
  type RouteGuard,
  registerMountedRoutes,
} from '@ultimat3/render';
import type { AdminRoute } from './admin';
import { AdminPageUnguardedError } from './errors';

/** What `RouteDescriptor.file` reads for an admin route: the package, since no app file is one. */
export const ADMIN_ROUTE_FILE = '@ultimat3/admin';

export interface AdminRouteDefinition {
  /** The coarse gate — the SAME object `config.policy` carries. */
  readonly policy: RouteGuard;
  readonly config: RouteConfig;
}

/**
 * The author never writes this `defineRoute` call, so the author cannot omit its `policy` —
 * which is the whole mechanism. The coarse gate is `permissions[0]` (always `admin:read`, put
 * there by `permissionsForOperation`/`pagePermissions`); the rest of the pair is decided per
 * request, in `crud.ts` for a resource screen and in `guardedScreen()` for every other one.
 * An empty list is refused here too: `render: 'ssr'` with no policy is a public dashboard.
 */
export function adminRouteDefinition(route: AdminRoute): AdminRouteDefinition {
  const permission = route.permissions[0];
  if (permission === undefined) throw new AdminPageUnguardedError({ path: route.path });
  const policy: RouteGuard = { permission };
  return {
    policy,
    config: defineRoute({
      // One mode for every admin route, never an author's choice. `ssr` renders the rows behind
      // the guard, once per request, and `hydrate: 'never'` means the screen ships no JS at all:
      // every control on an admin screen is a link or a native form, so there is nothing to
      // hydrate. `never` is a REFUSAL and not just a default — an `island()` rendered on this
      // route throws `X_ISLAND_NOT_HYDRATED` (`@ultimat3/render`'s `island-collector.ts`), and no
      // admin module declares one.
      render: 'ssr',
      offline: 'network-only',
      hydrate: 'never',
      policy,
      // Never indexed and never followed, whatever the screen answers — a list, a refusal, a 404:
      // an admin URL in a search result is a row id handed to a crawler.
      meta: () => ({ title: t(route.titleKey), robots: { index: false, follow: false } }),
    }),
  };
}

/**
 * Declare an admin's routes to the framework's route table — as MOUNTED routes, each with every
 * permission that gates it — so `x routes`, the `/_x` routes panel, the manifest and `sw.js` list
 * them from the one projection everything else is listed from. Keyed by base path: re-declaring
 * the admin (a save under `x dev`) replaces its set.
 */
export function mountAdminRoutes(basePath: string, routes: readonly AdminRoute[]): void {
  registerMountedRoutes(
    { key: basePath, by: 'defineAdmin', file: ADMIN_ROUTE_FILE, surface: 'app' },
    routes.map((route) => ({
      path: route.path,
      config: adminRouteDefinition(route).config,
      permissions: route.permissions,
    })),
  );
}
