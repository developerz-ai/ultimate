// The one place a route gets its SCREEN, and the matcher a host asks per request. The config a
// route is served under — `ssr`, gated, `network-only` — is `route-config.ts`'s; this file binds
// it to what renders there.

import { compilePattern, type RouteConfig, type RouteGuard } from '@ultimat3/render';
import type { AdminApp, AdminRoute } from './admin';
import { AdminPagePathInvalidError } from './errors';
import { adminRouteDefinition } from './route-config';
import type { AdminRouteRequest, AdminRouteResponse } from './screen-frame';
import { screenFor } from './screens';

export interface AdminRouteConfig {
  readonly path: string;
  readonly view: AdminRoute['view'];
  readonly entity: string | null;
  readonly permissions: readonly string[];
  /**
   * The coarse gate, already composed — the SAME object `config.policy` carries. It is here, and
   * not read back off `config`, because `RouteConfig.policy` is optional.
   */
  readonly policy: RouteGuard;
  readonly config: RouteConfig;
  /**
   * Answer one request to this route — a GET, or the form the screen posted back at itself — as
   * a status and a framed body, or the redirect a write that worked earns. Never absent: a
   * generated view renders its rows and a custom page is wrapped, so no route of the table is a
   * path with nothing behind it. The screen decides before it renders; a host only serialises.
   */
  respond(request: AdminRouteRequest): Promise<AdminRouteResponse>;
}

/** One route of the table, with its gate, its served config and its screen. */
export function adminRouteConfig(app: AdminApp, route: AdminRoute): AdminRouteConfig {
  const { policy, config } = adminRouteDefinition(route);
  return {
    path: route.path,
    view: route.view,
    entity: route.entity,
    permissions: route.permissions,
    respond: screenFor(app, route),
    policy,
    config,
  };
}

/** Every route of the table, each with its screen. Auth stays the host app's: see `AdminApp.auth`. */
export function adminRoutes(app: AdminApp): readonly AdminRouteConfig[] {
  return app.routes.map((route) => adminRouteConfig(app, route));
}

/**
 * The one route the admin declares for `path` — a read of the table, for a caller that wants a
 * route's gate or its screen without matching a URL.
 *
 * A path the table does not declare is refused rather than answered with a default: a mount with
 * no route is a screen whose permissions nothing composed, which is exactly the shape `pages:`
 * exists to make impossible.
 */
export function adminRouteFor(app: AdminApp, path: string): AdminRouteConfig {
  const route = app.routes.find((candidate) => candidate.path === path);
  if (route === undefined) {
    throw new AdminPagePathInvalidError({
      path,
      cause: 'is not a route this admin declares',
      fix:
        'serve one of the paths defineAdmin() built — ' +
        `${app.routes.map((candidate) => candidate.path).join(', ')} — ` +
        'or declare this one in `pages:` on defineAdmin()',
    });
  }
  return adminRouteConfig(app, route);
}

export interface AdminRouteMatch {
  readonly route: AdminRouteConfig;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * The route a REQUEST's pathname names, with its params — what a host mounting the admin under
 * one catch-all asks per request. `null` is "no admin screen lives there", which the host answers
 * 404. The most specific pattern wins, so `/posts/new` is the create form and never the detail
 * of a row called `new`. Matched against the table as it is NOW, so a page added in a save is
 * served without the host re-reading anything.
 */
export function adminRouteMatch(app: AdminApp, pathname: string): AdminRouteMatch | null {
  let best: { route: AdminRoute; params: Record<string, string>; specificity: number } | null =
    null;
  for (const route of app.routes) {
    const pattern = compilePattern(route.path);
    const found = pattern.regex.exec(pathname);
    if (found === null || (best !== null && best.specificity >= pattern.specificity)) continue;
    const params: Record<string, string> = {};
    pattern.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(found[index + 1] ?? '');
    });
    best = { route, params, specificity: pattern.specificity };
  }
  return best === null ? null : { route: adminRouteConfig(app, best.route), params: best.params };
}
