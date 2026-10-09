// `claimAdminRoute()` — an app FILE serves one admin path in the catch-all's place, so the page
// keeps the app's own shell and its islands (`hydrate`, budget and island bundle are a file
// route's). The guard is not the app's: the route's gate, its `meta`, and a `load` that answers
// through the SAME screen the catch-all serves (`screenFor`), unframed. `claims.ts` records the
// config issued, and the route table accepts no other on that path.

import { type HydrateStrategy, hasContext, isUltimateError } from '@ultimat3/core';
import { setRedirect, useRequestHeaders } from '@ultimat3/http';
import {
  defineRoute,
  type RouteBudget,
  type RouteConfig,
  type RouteNavigationMode,
  routeStatusOf,
  withStatus,
} from '@ultimat3/render';
import type { JSX } from 'solid-js';
import type { AdminApp, AdminView } from './admin';
import { issueClaim } from './claims';
import type { CrudCtx } from './crud';
import { AdminPagePathInvalidError } from './errors';
import type { NavGroup } from './nav';
import { adminRouteGuard, adminRouteMeta } from './route-config';
import { screenFor } from './screens';

/** What the app's own `load` is handed — called for every visitor the screen answered. */
export interface AdminClaimLoadArgs {
  readonly ctx: CrudCtx;
  readonly params: Readonly<Record<string, string>>;
  readonly url: string;
  /** The body is the refusal (403), which carries its own `<h1>`. */
  readonly denied: boolean;
}

export interface ClaimAdminRouteOptions<TApp> {
  /** Absent: derived from the islands declared above the call, as for any route. */
  readonly hydrate?: HydrateStrategy;
  readonly budget?: RouteBudget;
  readonly navigation?: RouteNavigationMode;
  /**
   * The app's half of the page data — its shell's role, locale and enrolment flag; a claimed
   * dashboard's own figures. Runs AFTER the screen decided, the refused included: when `denied`
   * it may read the visitor, never what the page guards. Answering `withStatus(404, …)` sets the
   * page's status when the screen answered 200.
   */
  readonly load?: (args: AdminClaimLoadArgs) => TApp | Promise<TApp>;
}

/** What the claimed route's `load` hands the app's page component. */
export interface AdminClaimData<TApp = undefined> {
  /** The screen's body, decided and unframed: the page, or the refusal naming the permission. */
  readonly body: JSX.Element;
  readonly status: number;
  readonly denied: boolean;
  /** The route's title key; the body of a refusal carries its own heading. */
  readonly titleKey: string;
  /** The nav this actor may see — the admin's `navFor`. */
  readonly nav: readonly NavGroup[];
  /** What `options.load` returned; `undefined` without one. */
  readonly app: TApp;
}

/**
 * A `pages:` entry and the dashboard only. A generated screen posts its forms back to its own URL
 * and re-renders a refused write there — in the admin's layout, from the catch-all — so a claim
 * would split one screen across two shells.
 */
const CLAIMABLE: ReadonlySet<AdminView> = new Set<AdminView>(['page', 'dashboard']);

/**
 * The route config for the app file at `path` (the table's full path, base included). Call it
 * BELOW the module's `island()` declarations, as `export const config = claimAdminRoute(…)`: its
 * `defineRoute` drains them, which is how the page hydrates.
 */
export function claimAdminRoute<TApp = undefined>(
  admin: AdminApp,
  path: string,
  options: ClaimAdminRouteOptions<TApp> = {},
): RouteConfig<AdminClaimData<TApp>> {
  const route = admin.routes.find((candidate) => candidate.path === path);
  if (route === undefined) {
    throw new AdminPagePathInvalidError({
      path,
      cause: 'is not a route this admin declares',
      fix: `claimAdminRoute(admin, '<path>') with one of ${claimablePaths(admin)} — or add { path, titleKey, permissions, component } to pages: on defineAdmin()`,
    });
  }
  if (!CLAIMABLE.has(route.view)) {
    throw new AdminPagePathInvalidError({
      path,
      cause: `is the generated ${route.view} screen, which only the admin serves`,
      fix: `claimAdminRoute(admin, '<path>') with one of ${claimablePaths(admin)}: a pages: entry or the dashboard`,
    });
  }
  const screen = screenFor(admin, route);
  const config = defineRoute<AdminClaimData<TApp>>({
    render: 'ssr',
    offline: 'network-only',
    policy: adminRouteGuard(route),
    meta: adminRouteMeta(route),
    ...(options.hydrate === undefined ? {} : { hydrate: options.hydrate }),
    ...(options.budget === undefined ? {} : { budget: options.budget }),
    ...(options.navigation === undefined ? {} : { navigation: options.navigation }),
    load: async ({ params, url }) => {
      // The actor exactly as the catch-all resolves it: the admin's `auth.actor` over this request.
      const ctx = await admin.requestCtx(new Request(url, { headers: requestHeaders() }));
      const response = await screen({ ctx, params, url, method: 'GET', form: null, frame: 'none' });
      if (response.kind === 'redirect') setRedirect(response.location, 303);
      const body = response.kind === 'document' ? response.body : null;
      const answered = response.kind === 'document' ? response.status : 200;
      const denied = answered === 403;
      const own = (await options.load?.({ ctx, params, url, denied })) as TApp;
      const status = answered === 200 ? routeStatusOf(own) : answered;
      const data: AdminClaimData<TApp> = {
        body,
        status,
        denied,
        titleKey: route.titleKey,
        nav: admin.navFor(ctx),
        app: own,
      };
      return status === 200 ? data : withStatus(status, data);
    },
  });
  return issueClaim(route.path, config);
}

/**
 * The headers of the request being rendered — the session cookie `auth.actor` reads. Outside a
 * request (a test rendering the route) there are none, and the actor resolves as nobody: refused.
 */
function requestHeaders(): Headers {
  if (!hasContext()) return new Headers();
  try {
    return useRequestHeaders();
  } catch (error) {
    if (isUltimateError(error) && error.code === 'X_NO_REQUEST') return new Headers();
    throw error;
  }
}

const claimablePaths = (admin: AdminApp): string =>
  admin.routes
    .filter((route) => CLAIMABLE.has(route.view))
    .map((route) => route.path)
    .join(', ');
