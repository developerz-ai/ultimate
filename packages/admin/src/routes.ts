// The one bridge from the admin's route table to @ultimat3/render, and the one place a policy
// is composed onto an admin page. A generated view is `spa`: it is behind auth, so there is
// nothing to prerender and nothing a CDN may hold — and `network-only` keeps a stale org's rows
// out of a service worker cache. A custom page is `ssr`, because its guard runs on the server.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import type { AdminApp, AdminRoute } from './admin';
import { AdminPageUnguardedError } from './errors';
import { guardedPage } from './page-guard';
import type { AdminPageComponent } from './pages';

export interface AdminRouteConfig {
  readonly path: string;
  readonly view: AdminRoute['view'];
  readonly entity: string | null;
  readonly permissions: readonly string[];
  /** The GUARDED component of a custom page; `null` for a generated view. */
  readonly component: AdminPageComponent | null;
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

  return {
    path: route.path,
    view: route.view,
    entity: route.entity,
    permissions: route.permissions,
    component: route.component === undefined ? null : guardedPage(route, route.component),
    config: defineRoute({
      // A custom page renders server data behind the guard; a generated view is a shell that
      // fetches through the admin's own gated calls. One mode each, never an author's choice.
      render: custom ? 'ssr' : 'spa',
      offline: 'network-only',
      hydrate: custom ? 'never' : 'idle',
      policy: { permission },
      meta: () => ({ title: t(route.titleKey) }),
    }),
  };
}

/** Hand these to the router. Auth stays the host app's: see `AdminApp.auth`. */
export function adminRoutes(app: AdminApp): readonly AdminRouteConfig[] {
  return app.routes.map(adminRouteConfig);
}
