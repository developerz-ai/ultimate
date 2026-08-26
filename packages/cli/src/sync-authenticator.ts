// The app's HTTP authenticator, seen as the `sync` node's. Until this file `sync-node.ts` was
// handed no `authenticate` by any host, so every socket the framework ever opened carried
// `actorId: null` — and the channel guard, the live-query gate, the presence entry and the
// per-tenant subscription cap all decided against an anonymous actor. Realtime was single-tenant
// by wiring, not by design.

import type { Actor, Clock } from '@ultimat3/core';
import { finiteCount, systemClock } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import {
  configuredAuthenticator,
  createRequestContext,
  defineHttpConfig,
  UltimateRequest,
} from '@ultimat3/http';
import type { SyncAuthenticator, SyncGrant } from '@ultimat3/realtime/server';

/**
 * How long one grant stands before the node re-decides it.
 *
 * A grant with no expiry never appears in `GrantBook.expired()`, so `sweepGrants` — the only path
 * to `hub.onActorChange` and `registry.reauthorize` — never fired for a socket this adapter opened.
 * `logout`, `revokeSession`, `disableUser` and `updatePrivileges` closed the HTTP session and never
 * the websocket, and the client's 15s heartbeat beats the 120s idle sweep, so the socket stayed up
 * with the revoked actor's authority for as long as the tab was open.
 *
 * Five minutes, against `DEFAULT_REAUTH_INTERVAL_MS` (30s): the window a revoked actor keeps its
 * socket is this plus one sweep, and the cost is one resolver call per socket per window — 167/s
 * on the 50,000-socket node this repo has measured, against 1,667/s at a 30s TTL. A deployment
 * whose credential has a shorter real lifetime passes `runtime.syncAuthenticate` and states it.
 */
export const SYNC_GRANT_TTL_MS = 5 * 60_000;

/**
 * The credential this adapter retains per socket, and nothing else.
 *
 * `sync-auth.ts` says the seam is a closure precisely so a node does not hold one `Request` per
 * connection for the life of that connection: `SyncSocket`'s budget is ~1KB and the grant sits
 * beside it. Two header values is what an app that closes over a token string would hold.
 *
 * Dropping the rest can only make a refresh MORE restrictive, never more permissive: an app that
 * resolves identity from some other header sees its refresh answer `null`, which closes the socket
 * with `1008` and the client re-dials carrying that header again. One reconnect per window, not an
 * escalation — and `runtime.syncAuthenticate` is the declared seam for stating something else.
 */
const CREDENTIAL_HEADERS = ['cookie', 'authorization'] as const;

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

/** What the closure keeps: enough to ask the app's resolver the same question a second time. */
interface Credential {
  readonly url: string;
  readonly method: string;
  readonly headers: Headers;
}

function credentialOf(request: Request): Credential {
  const headers = new Headers();
  for (const name of CREDENTIAL_HEADERS) {
    const value = request.headers.get(name);
    if (value !== null) headers.set(name, value);
  }
  return { url: request.url, method: request.method, headers };
}

export interface SyncAuthenticatorOptions {
  /** The clock a grant's window is measured on. Injected so a re-auth is provable without sleeping. */
  readonly clock?: Clock;
  /** Overrides `SYNC_GRANT_TTL_MS`. A test names its own window; nothing in the boot passes one. */
  readonly ttlMs?: number;
}

/**
 * What the sync node is given when the app configured an authenticator, and `undefined` when it
 * did not — which keeps `x dev` anonymous and makes the node log that it is, exactly as
 * `createSyncNode` documents. A stub that answered `{ actor: anonymous }` would look configured.
 *
 * The grant carries an `expiresAt` and a `refresh`, and both are the app's own resolver asked
 * again: `configureAuthenticator` says who is dialling, and the only honest way to learn that it
 * has stopped being true is to ask. A `null` second answer is a revocation the node turns into a
 * `1008`; a THROW is a backend failure, and `sweepGrants` keeps the grant and retries — the
 * adapter must not collapse those two, here or on the refresh path.
 */
export function syncAuthenticator(
  buildId: string,
  options: SyncAuthenticatorOptions = {},
): SyncAuthenticator | undefined {
  const authenticate = configuredAuthenticator();
  if (authenticate === undefined) return undefined;
  // Once per node, not once per upgrade: resolving a config is pure and a 50k-socket node pays
  // this per connection otherwise.
  const config = upgradeConfig(buildId);
  const clock = options.clock ?? systemClock;
  // A credential lifetime, screened where it is declared. `expiresAt` is `now + ttlMs`, and
  // `GrantBook.expired()` asks `expiresAt <= now` — false for every `now` when the sum is `NaN`,
  // so the grant never reaches a sweep and the socket keeps a revoked actor's authority for as
  // long as the tab is open. That is the hole this whole file was written to close, and a `??`
  // does not close it: `NaN` is not nullish. At least 1ms — a window that has already shut when
  // the grant is minted is not a window.
  const ttlMs = finiteCount('syncAuthenticator', 'ttlMs', options.ttlMs ?? SYNC_GRANT_TTL_MS, 1);

  const resolve = async (credential: Credential): Promise<SyncGrant | null> => {
    const request = new Request(credential.url, {
      method: credential.method,
      headers: credential.headers,
    });
    const ctx = createRequestContext({
      url: new URL(credential.url),
      method: credential.method,
      role: 'sync',
      config,
      requestHeaders: credential.headers,
    });
    const actor: Actor | null = await authenticate(new UltimateRequest(request, ctx), ctx);
    if (actor === null) return null;
    return {
      // The window is measured from the answer, not from the upgrade: a refreshed grant that
      // returned its original instant would be expired again on the very next pass.
      actor,
      expiresAt: clock.now().getTime() + ttlMs,
      refresh: () => resolve(credential),
    };
  };

  return async (request: Request): Promise<SyncGrant | null> => resolve(credentialOf(request));
}
