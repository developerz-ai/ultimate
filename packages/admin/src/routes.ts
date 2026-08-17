// The one bridge from the admin's route table to @ultimat3/render, and the one place a policy
// is composed onto an admin page. A generated view is `spa`: it is behind auth, so there is
// nothing to prerender and nothing a CDN may hold — and `network-only` keeps a stale org's rows
// out of a service worker cache. A custom page is `ssr`, because its guard runs on the server.

import { t } from '@ultimat3/i18n';
import { defineRoute, type RouteGuard } from '@ultimat3/render';
import type { AdminApp, AdminRoute } from './admin';
import { AdminPagePathInvalidError, AdminPageUnguardedError } from './errors';
import { guardedPage } from './page-guard';
import type { AdminPageComponent } from './pages';

export interface AdminRouteConfig {
  readonly path: string;
  readonly view: AdminRoute['view'];
  readonly entity: string | null;
  readonly permissions: readonly string[];
  /** The GUARDED component of a custom page; `null` for a generated view. */
  readonly component: AdminPageComponent | null;
  /**
   * The coarse gate, already composed — the SAME object `config.policy` carries. It is here, and
   * not read back off `config`, because `RouteConfig.policy` is optional: a host that serves an
   * admin URL from its own file has to be able to take the gate without proving it exists.
   */
  readonly policy: RouteGuard;
  readonly config: ReturnType<typeof defineRoute>;
}

/**
 * The author never writes this `defineRoute` call, so the author cannot omit its `policy` —
 * which is the whole mechanism. The coarse gate is `permissions[0]` (always `admin:read`, put
 * there by `permissionsForOperation`/`pagePermissions`); the rest of the pair is decided per
 * request by `decideAll`, in `crud.ts` for a generated view and in `page-guard.tsx` for a page.
 * An empty list is refused here too: `render: 'spa'` and `'ssr'` would both ship a public shell.
 */
export function adminRouteConfig(route: AdminRoute): AdminRouteConfig {
  const permission = route.permissions[0];
  if (permission === undefined) throw new AdminPageUnguardedError({ path: route.path });
  const custom = route.component !== undefined;
  const policy: RouteGuard = { permission };

  return {
    path: route.path,
    view: route.view,
    entity: route.entity,
    permissions: route.permissions,
    component: route.component === undefined ? null : guardedPage(route, route.component),
    policy,
    config: defineRoute({
      // A custom page renders server data behind the guard; a generated view is a shell that
      // fetches through the admin's own gated calls. One mode each, never an author's choice.
      render: custom ? 'ssr' : 'spa',
      offline: 'network-only',
      hydrate: custom ? 'never' : 'idle',
      policy,
      meta: () => ({ title: t(route.titleKey) }),
    }),
  };
}

/** Hand these to the router. Auth stays the host app's: see `AdminApp.auth`. */
export function adminRoutes(app: AdminApp): readonly AdminRouteConfig[] {
  return app.routes.map(adminRouteConfig);
}

/**
 * The one route the admin declares for `path` — the lookup a host performs when it serves an admin
 * URL from its own file rather than from `adminRoutes()`.
 *
 * It exists because the alternative is what the deployed demo shipped: a page file typing
 * `policy: { permission: 'admin:read' }` beside a route table that separately declared
 * `permissionsForOperation(...)` for the same URL. Two declarations of one URL's authz agree until
 * one of them is edited, and nothing was ever going to notice. Reading the gate from here means
 * there is one declaration and one reader.
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
  return adminRouteConfig(route);
}
