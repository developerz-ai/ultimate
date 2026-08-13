// The app's API over HTTP, composed once: the write half `@ultimat3/action` projects and the read
// half `@ultimat3/query` projects. `x dev` and `serve.ts` both mount THIS rather than each listing
// the registries themselves — two lists is how `query.client()` shipped deriving `/_x/query/<kebab>`
// against a route neither file mounted, compiling everywhere and 404ing everywhere.

import { listActions, toRoute } from '@ultimat3/action';
import type { Route } from '@ultimat3/http';
import { listQueries, toQueryRoute } from '@ultimat3/query';

/**
 * Whatever loading the app's modules put in the two registries, as routes. Read at call time,
 * never at import: importing the app IS the registration, and it happens after this module loads.
 */
export function apiRoutes(): readonly Route[] {
  return [...listActions().map(toRoute), ...listQueries().map(toQueryRoute)];
}
