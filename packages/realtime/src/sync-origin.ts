// Single responsibility: whether a websocket upgrade may carry this app's ambient credential. No
// CORS applies to a websocket and the session cookie rides it, so without this a page that is not
// this app opened a socket as its visitor. The rule is core's `proveSameOrigin`, the one
// `@ultimat3/http`'s CSRF check asks too.

import { type OriginVerdict, proveSameOrigin } from '@ultimat3/core';

/**
 * Admitted, in order:
 * - **no `Origin`** — RFC 6455 has a browser send one on every handshake, so a dial without it is
 *   not a browser and no visitor's cookie can be riding it;
 * - **`allowedOrigins`, exactly, when any is declared** (`APP_URL`'s origin, from the CLI). A
 *   declaration IS the app's origin, so it is the whole list: the origin the node sees is derived
 *   from the `Host` header, which names whatever host the request was aimed at — a sibling
 *   subdomain pointed at this node is "its own origin" by that reading, and a `Domain=`-wide
 *   session cookie rides its socket;
 * - **the node's own ORIGIN, only when nothing is declared** — host and port exactly as the
 *   request reached it (`x dev`, a combined-role container). A host name alone is not this app:
 *   cookies are not isolated by port. `admitReached` keeps it beside a declared list (`x dev`).
 */
export function upgradeOrigin(
  request: Request,
  url: URL,
  allowedOrigins: readonly string[],
  admitReached = false,
): OriginVerdict {
  const origin = request.headers.get('origin');
  if (origin === null) return { ok: true };
  // Normalised once (`https://x/` and `https://x` are one origin), then matched as whole strings.
  const admitted = allowedOrigins.map((allowed) => URL.parse(allowed)?.origin);
  return proveSameOrigin({
    selfOrigins: admitted.length > 0 && !admitReached ? [] : selfOrigins(url),
    origin,
    secFetchSite: request.headers.get('sec-fetch-site'),
    listed: (asked) => admitted.includes(asked),
    listName: 'APP_URL or createSyncNode({ allowedOrigins })',
  });
}

/**
 * The origins an UNDECLARED node is reached on. TLS usually ends at a proxy, so a node reached over
 * plain http cannot know its pages' scheme: the https spelling of the same host and port is this
 * app too. That also admits the plain-http page, which is why a deployment behind TLS declares
 * `APP_URL` — the chart sets it from the ingress host.
 */
function selfOrigins(url: URL): readonly string[] {
  return url.protocol === 'http:' ? [url.origin, `https://${url.host}`] : [url.origin];
}
