// The app's HTTP authenticator, seen as the `sync` node's. Until this file `sync-node.ts` was
// handed no `authenticate` by any host, so every socket the framework ever opened carried
// `actorId: null` — and the channel guard, the live-query gate, the presence entry and the
// per-tenant subscription cap all decided against an anonymous actor. Realtime was single-tenant
// by wiring, not by design.

import type { Actor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import {
  configuredAuthenticator,
  createRequestContext,
  defineHttpConfig,
  UltimateRequest,
} from '@ultimat3/http';
import type { SyncAuthenticator, SyncGrant } from '@ultimat3/realtime';

/**
 * The upgrade request, dressed as the request an `Authenticator` reads.
 *
 * A websocket upgrade IS an HTTP request — same cookies, same `Authorization` header — so the
 * app's one resolver answers it, and an app does not write a second identity for its sockets.
 * The limiter is off because nothing in this config path serves a request: it exists so
 * `ctx.config` is a real `HttpConfig`, and a rate limit resolved here would be a second, unread
 * declaration of the app's own numbers.
 */
function upgradeConfig(buildId: string): HttpConfig {
  return defineHttpConfig({ buildId, rateLimit: { enabled: false, scope: 'process' } });
}

/**
 * What the sync node is given when the app configured an authenticator, and `undefined` when it
 * did not — which keeps `x dev` anonymous and makes the node log that it is, exactly as
 * `createSyncNode` documents. A stub that answered `{ actor: anonymous }` would look configured.
 *
 * The grant carries **no `expiresAt` and no `refresh`**, and that is the honest limit of this
 * adapter rather than an omission: `configureAuthenticator()` resolves an `Actor` and says nothing
 * about how long it stays true, so inventing a window here would either close live sockets that
 * are still authorized or claim a lifetime the app never promised. A deployment whose credential
 * has a real expiry passes `runtime.syncAuthenticate` and gets re-authorization; the timer for it
 * already lives in `createSyncNode.start()`.
 */
export function syncAuthenticator(buildId: string): SyncAuthenticator | undefined {
  const authenticate = configuredAuthenticator();
  if (authenticate === undefined) return undefined;
  // Once per node, not once per upgrade: resolving a config is pure and a 50k-socket node pays
  // this per connection otherwise.
  const config = upgradeConfig(buildId);
  return async (request: Request): Promise<SyncGrant | null> => {
    const ctx = createRequestContext({
      url: new URL(request.url),
      method: request.method,
      role: 'sync',
      config,
      requestHeaders: request.headers,
    });
    const actor: Actor | null = await authenticate(new UltimateRequest(request, ctx), ctx);
    return actor === null ? null : { actor };
  };
}
