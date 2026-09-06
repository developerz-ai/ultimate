// Serving the surface stylesheets. `x dev` and the container mount the same route over the same
// table, for `island-routes.ts`' reason: the URL is minted by one resolver and baked into the
// document, so a dev-only path would be a page that paints in `x dev` and renders naked in the
// image.

import type { Route, UltimateRequest } from '@ultimat3/http';
import { applyCacheHeaders, json } from '@ultimat3/http';
import type { StyleBundle } from './style-bundle';
import { STYLE_BASE_PATH } from './style-bundle';

/**
 * A getter, not the bundle: `x dev` re-registers island CSS on every watcher tick, and a table
 * captured when the route was mounted would serve the stylesheet as it was at boot for the rest of
 * the session.
 */
export type StyleSource = () => StyleBundle;

/**
 * The URL is content-addressed, so the bytes behind it never change and the answer is
 * `public, max-age=31536000, immutable` — the same headers an island chunk earns, and the whole
 * reason this is a file rather than 157 kB of `<style>` inside a `no-store` document.
 *
 * A miss can only be a document older than this process's registry, which is a fact worth stating
 * rather than a bare 404 whose meaning an agent has to guess.
 */
export function styleRoutes(source: StyleSource): readonly Route[] {
  return [
    {
      method: 'GET',
      path: `${STYLE_BASE_PATH}/*file`,
      meta: { name: 'assets.style', auth: 'public', tags: ['assets'] },
      handler: (request: UltimateRequest): Response => {
        const chunk = source().chunkAt(request.pathname);
        if (chunk === undefined) {
          return json(
            {
              ok: false,
              error: {
                code: 'X_ROUTE_NOT_FOUND',
                cause: `no surface stylesheet is registered at ${request.pathname} — the document that asked for it was rendered against an older build`,
                // No `x` citation, for `island-routes.ts`' reason: this route is mounted in
                // exactly two places (`cmd-dev.ts`, `serve.ts`) and neither reads `.x/static`.
                fix: 'reload the page — this process serves only the stylesheet its own modules registered, and the document holding this URL came from an earlier build',
              },
            },
            { status: 404 },
          );
        }
        return applyCacheHeaders(
          new Response(chunk.css, { headers: { 'content-type': 'text/css; charset=utf-8' } }),
          { mode: 'immutable' },
        );
      },
    },
  ];
}
