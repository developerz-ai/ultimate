/**
 * `spa` — shell only, client fetches everything. For dashboards behind auth, where the
 * shell is identical for every actor and therefore cacheable, and the data is not.
 * `modes.ts` requires a `policy` on this mode: nothing is server-rendered, so the route
 * itself is the only place authz can live.
 */

import { RouteModeInvalidError } from './errors';
import type { RouteEntry } from './registry';
import { contentHash } from './render-static';
import type { RenderResult } from './route';

export const SPA_ROOT_ID = 'x-root';

export interface SpaShellInput {
  readonly entry: RouteEntry;
  readonly buildId: string;
  /** Everything inside `<head>`, already merged by `head.ts`. */
  readonly head: string;
  /** Build-id-immutable chunk URLs to preload; order is preserved for determinism. */
  readonly chunks: readonly string[];
  readonly rootId?: string;
  readonly lang: string;
  readonly dir?: 'ltr' | 'rtl';
}

export interface SpaShell {
  readonly html: string;
  readonly hash: string;
}

export function renderSpaShell(input: SpaShellInput): SpaShell {
  if (input.entry.config.policy === undefined) {
    throw new RouteModeInvalidError(
      `${input.entry.file} declares render: 'spa' with no policy, so the shell would be public`,
      `add policy: can('…') to ${input.entry.file}`,
    );
  }

  const rootId = input.rootId ?? SPA_ROOT_ID;
  const preloads = input.chunks
    .map((chunk) => `<link rel="modulepreload" href="${chunk}">`)
    .join('');
  const scripts = input.chunks
    .map((chunk) => `<script type="module" src="${chunk}"></script>`)
    .join('');

  const html =
    `<!doctype html><html lang="${input.lang}" dir="${input.dir ?? 'ltr'}">` +
    `<head>${input.head}${preloads}` +
    `<meta name="x-ultimate-build" content="${input.buildId}">` +
    `</head><body><div id="${rootId}"></div>${scripts}</body></html>`;

  return { html, hash: contentHash(html) };
}

/**
 * The shell is identical for every actor, so it is cache-first in `sw.js` and
 * revalidate-on-navigation over HTTP. The build id in the document is what
 * `@ultimat3/pwa`'s skew detection compares against the server's.
 */
export function renderSpa(input: SpaShellInput): RenderResult {
  const shell = renderSpaShell(input);
  return {
    status: 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'private, max-age=0, must-revalidate',
      etag: `"${shell.hash}"`,
      'x-ultimate-build': input.buildId,
    },
    body: shell.html,
  };
}
