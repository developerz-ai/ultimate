// Single responsibility: whether a websocket upgrade may carry this app's ambient credential. No
// CORS applies to a websocket and the session cookie rides it, so without this a page on a sibling
// host (same-site, so `SameSite=Lax` does not stop it) opened a socket as its visitor. The rule is
// core's `proveSameOrigin`, the one `@ultimat3/http`'s CSRF check asks too.

import { type OriginVerdict, proveSameOrigin } from '@ultimat3/core';

/**
 * Admitted, in order:
 * - **no `Origin`** — RFC 6455 has a browser send one on every handshake, so a dial without it is
 *   not a browser and no visitor's cookie can be riding it;
 * - **the node's own host name**, whatever the port or scheme — cookies are not port-isolated, so
 *   the page on `:3000` dialling the Compose rung's `:3001` is the same credential boundary, and a
 *   TLS-terminating ingress means the node cannot know the page's scheme;
 * - otherwise core's rule, with `allowedOrigins` as the exact list (`APP_URL`'s origin, from the
 *   CLI, when the page is served on another host than the node).
 */
export function upgradeOrigin(
  request: Request,
  url: URL,
  allowedOrigins: readonly string[],
): OriginVerdict {
  const origin = request.headers.get('origin');
  if (origin === null) return { ok: true };
  if (URL.parse(origin)?.hostname === url.hostname) return { ok: true };
  return proveSameOrigin({
    selfOrigins: allowedOrigins,
    origin,
    secFetchSite: request.headers.get('sec-fetch-site'),
    listed: () => false,
    listName: 'APP_URL or createSyncNode({ allowedOrigins })',
  });
}
