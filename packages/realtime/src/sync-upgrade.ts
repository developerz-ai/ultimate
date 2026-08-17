// The node's HTTP surface: health, readiness, load shedding and the authenticated upgrade. Split
// from `sync-node.ts` because deciding whether a request becomes a websocket is a different job
// from what the socket then does — the same line `sync-frames.ts` and `sync-listen.ts` already draw.

import { healthzPayload, readyzPayload, reportError } from '@ultimat3/core';
import { SocketAuthUnavailableError, SocketUnauthenticatedError } from './errors';
import type { SyncAuthenticator, SyncGrant } from './sync-auth';
import { toWireError } from './sync-protocol';
import type { AcceptBudget, Rng } from './thundering-herd';

/**
 * What the upgrade hands the socket. It carries no actor: the grant does, and one identity written
 * in two places is two that disagree the moment a re-auth renews one of them.
 */
export interface WsData {
  readonly socketId: string;
  readonly clientBuildId: string;
}

/** Structural view of `Bun.serve`'s server object; keeps this module free of a Bun import. */
export interface UpgradeTarget {
  upgrade(request: Request, options: { data: WsData }): boolean;
}

/**
 * Everything the decision reads, supplied by the node. `ready` and `socketCount` are functions
 * rather than values because both move while a request is parked inside `authenticate` — reading
 * them once at the top is exactly the staleness this file exists to refuse.
 */
export interface UpgradeDeps {
  readonly path: string;
  readonly buildId: string;
  readonly maxConnections: number;
  readonly accept: AcceptBudget;
  readonly rng: Rng;
  ready(): boolean;
  socketCount(): number;
  newSocketId(): string;
  readonly authenticate?: SyncAuthenticator | undefined;
  /** Recorded only after the upgrade took: a grant for a socket that never opened is never closed. */
  onGranted(socketId: string, grant: SyncGrant): void;
}

/**
 * `undefined` means the upgrade took and Bun owns the connection now. Async because `authenticate`
 * is: the credential is decided *before* `server.upgrade`, so a refused one never costs a websocket.
 */
export async function handleUpgrade(
  deps: UpgradeDeps,
  request: Request,
  server: UpgradeTarget,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  // Health is the process's, readiness is this node's: a draining node stays healthy while it hands
  // its sockets to the rest of the fleet.
  if (url.pathname === '/healthz') return json(healthzPayload());
  if (url.pathname === '/readyz') {
    const payload = readyzPayload();
    return deps.ready() ? json(payload) : json({ status: 503, body: payload.body });
  }
  if (url.pathname !== deps.path) return new Response('not found', { status: 404 });
  // The count, not the rate. Shed the same way and with the same delay attached: a client refused
  // for a full node and one refused for a fast one have the same next move, and the refusal is
  // decided before `authenticate` so a full node costs no token service call.
  if (deps.socketCount() >= deps.maxConnections || !deps.ready() || !deps.accept.tryAccept()) {
    return shed(deps);
  }
  let grant: SyncGrant | null = null;
  if (deps.authenticate) {
    try {
      grant = await deps.authenticate(request);
    } catch (error) {
      // A failure is not a denial. The token service timing out must not read to a client as "you
      // may not connect" — it is told to come back, and this node is the one that pages.
      reportError(error, { source: 'realtime', scope: { operation: 'sync.authenticate' } });
      return wireErrorResponse(
        503,
        new SocketAuthUnavailableError({ detail: 'see the node log for the cause' }),
      );
    }
    // The decision, made before a socket exists: an upgrade is the cheapest thing to refuse and the
    // most expensive thing to take back.
    if (grant === null) {
      return wireErrorResponse(
        401,
        new SocketUnauthenticatedError({ reason: 'authenticate() resolved no actor' }),
      );
    }
  }
  // Asked again, because `authenticate` is app code and awaiting it is awaiting a token service: a
  // request that passed the check above can be parked there when SIGTERM lands, and the `accept`
  // phase is over by the time it gets here. Upgrading then is the one socket that phase exists to
  // refuse — the load balancer has already been told this node is out, so nothing takes it over. No
  // second `tryAccept()`: that budget was spent above.
  if (!deps.ready()) return shed(deps);
  const data: WsData = {
    socketId: deps.newSocketId(),
    clientBuildId: url.searchParams.get('build') ?? deps.buildId,
  };
  if (!server.upgrade(request, { data })) {
    return new Response('expected websocket', { status: 426 });
  }
  if (grant) deps.onGranted(data.socketId, grant);
  return undefined;
}

/** Load shedding with a delay attached: refusing without one just moves the herd next door. */
function shed(deps: UpgradeDeps): Response {
  return new Response('retry', {
    status: 503,
    headers: { 'retry-after-ms': String(deps.accept.retryAfterMs(deps.rng)) },
  });
}

function wireErrorResponse(status: number, error: unknown): Response {
  return json({ status, body: { error: toWireError(error) } });
}

function json(payload: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(payload.body), {
    status: payload.status,
    headers: { 'content-type': 'application/json' },
  });
}
