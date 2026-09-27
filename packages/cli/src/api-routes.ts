// The app's API over HTTP, composed once: the write half `@ultimat3/action` projects and the read
// half `@ultimat3/query` projects. `x dev` and `serve.ts` both mount THIS rather than each listing
// the registries themselves — two lists is how `query.client()` shipped deriving `/_x/query/<kebab>`
// against a route neither file mounted, compiling everywhere and 404ing everywhere.
//
// And the two contributions that are the SAME primitives reached another way, composed here for
// the same reason: the bearer mounts `defineApi({ http: { mounts } })` declares (`/v1/*`), and the
// `POST` a page binds to an action (`defineRoute({ post })`).

import { apiDeclaration, getAction, listActions, toPostBinding, toRoute } from '@ultimat3/action';
import type { RateLimitStore, Route } from '@ultimat3/http';
import { bearerMount } from '@ultimat3/http';
import { listQueries, toQueryRoute } from '@ultimat3/query';
import { RoutePostInvalidError, routeEntries } from '@ultimat3/render';

/**
 * Whatever loading the app's modules put in the two registries, as routes. Read at call time,
 * never at import: importing the app IS the registration, and it happens after this module loads.
 */
export function apiRoutes(): readonly Route[] {
  return [...listActions().map(toRoute), ...listQueries().map(toQueryRoute)];
}

/**
 * Every bearer mount the app declared, over the SAME projected routes `apiRoutes()` serves — so
 * `/v1/create-case` runs `/api/create-case`'s handler, policy and idempotency, and only the
 * credential, the cut and the per-token allowance differ. `store` is the boot's rate-limit store,
 * so a fleet counts one token's allowance once.
 */
export function apiMountRoutes(store?: RateLimitStore): readonly Route[] {
  const mounts = apiDeclaration().http?.mounts ?? [];
  if (mounts.length === 0) return [];
  const routes = apiRoutes();
  return mounts.flatMap((mount) =>
    bearerMount({
      prefix: mount.prefix,
      routes,
      scopes: mount.scopes,
      resolveToken: mount.resolveToken,
      ...(mount.rateLimit === undefined ? {} : { rateLimit: mount.rateLimit }),
      ...(store === undefined ? {} : { rateLimitStore: store }),
    }),
  );
}

/**
 * `POST <page path>` for every page declaring `defineRoute({ post: '<action>' })`, answered by that
 * action with the URL's query merged over the posted fields. A name no action is registered under
 * is refused at boot (`X_ROUTE_POST_INVALID`) — a page promising a POST it cannot answer is the
 * one-click unsubscribe that silently never unsubscribes.
 */
export function pagePostRoutes(): readonly Route[] {
  const routes: Route[] = [];
  for (const entry of routeEntries()) {
    const name = entry.config.post;
    if (name === undefined) continue;
    const target = getAction(name);
    if (target === undefined) {
      throw new RoutePostInvalidError(
        `${entry.file} declares post: '${name}', and no action is registered under that name`,
      );
    }
    routes.push(toPostBinding(target, entry.path));
  }
  return routes;
}
