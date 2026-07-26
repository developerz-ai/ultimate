// The one bridge from the admin's route table to @ultimat3/render. Every admin page is
// `spa`: it is behind auth, so there is nothing to prerender and nothing a CDN may hold —
// and `network-only` keeps a stale org's rows out of a service worker cache.

import { t } from '@ultimat3/i18n';
import { defineRoute } from '@ultimat3/render';
import type { AdminApp, AdminRoute } from './admin';

export interface AdminRouteConfig {
  readonly path: string;
  readonly view: AdminRoute['view'];
  readonly entity: string | null;
  readonly permissions: readonly string[];
  readonly config: ReturnType<typeof defineRoute>;
}

export function adminRouteConfig(route: AdminRoute): AdminRouteConfig {
  return {
    path: route.path,
    view: route.view,
    entity: route.entity,
    permissions: route.permissions,
    config: defineRoute({
      render: 'spa',
      offline: 'network-only',
      hydrate: 'idle',
      meta: () => ({ title: t(route.titleKey) }),
    }),
  };
}

/** Hand these to the router. Auth stays the host app's: see `AdminApp.auth`. */
export function adminRoutes(app: AdminApp): readonly AdminRouteConfig[] {
  return app.routes.map(adminRouteConfig);
}
