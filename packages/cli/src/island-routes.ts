// Serving the island chunks a build produced. `x dev` and the container mount the same route over
// the same table, because a chunk URL is baked into the document by one resolver — a dev-only path
// would be a page that boots in `x dev` and 404s in the image.

import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, json } from '@ultimat3/http';
import type { IslandBundle } from './island-bundle';
import { ISLAND_BASE_PATH } from './island-bundle';

/**
 * A getter, not the bundle: `x dev` rebuilds the chunks on the same watcher tick that rebuilds the
 * manifest, and a table captured when the route was mounted would serve the island as it was at
 * boot for the rest of the session.
 */
export type IslandSource = () => IslandBundle;

/**
 * The URL is content-addressed, so the bytes behind it never change and the answer is immutable.
 * A miss can only be a document older than this process's chunks — which is a fact worth stating,
 * not a bare 404 whose meaning an agent has to guess.
 */
export function islandRoutes(source: IslandSource): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${ISLAND_BASE_PATH}/*file`,
      meta: { name: 'assets.island', auth: 'public', tags: ['assets'] },
      handler: (request: UltimateRequest): Response => {
        const chunk = source().chunkAt(request.pathname);
        if (chunk === undefined) {
          return json(
            {
              ok: false,
              error: {
                code: 'X_ROUTE_NOT_FOUND',
                cause: `no island chunk is built at ${request.pathname} — the document that asked for it was rendered against an older build`,
                // No `x` citation, deliberately — `dev-lock.ts`'s shape. This route is mounted
                // in exactly two places (`cmd-dev.ts`, `serve.ts`) and NEITHER reads `.x/static`:
                // in `x dev` the chunks are rebuilt on the watcher tick, and in the container they
                // were built at boot. `x build --target static` — which is what this said — writes
                // an export directory neither process serves from, so running it changed nothing
                // for the only two readers this line has ever had.
                fix: 'reload the page — this process serves only the chunks it built, and the document holding this URL came from an earlier build',
              },
            },
            { status: 404 },
          );
        }
        return applyCacheHeaders(
          new Response(chunk.code, { headers: { 'content-type': 'text/javascript' } }),
          { mode: 'immutable' },
        );
      },
    },
  ];
}
