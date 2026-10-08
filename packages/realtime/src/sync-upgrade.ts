// The node's HTTP surface: health, readiness, load shedding and the authenticated upgrade. Split
// from `sync-node.ts` because deciding whether a request becomes a websocket is a different job
// from what the socket then does — the same line `sync-frames.ts` and `sync-listen.ts` already draw.

import {
  type HealthPayload,
  healthBody,
  healthPeerListed,
  healthzPayload,
  readyzPayload,
  reportError,
} from '@ultimat3/core';
import {
  SocketAuthUnavailableError,
  SocketLimitError,
  SocketOriginRefusedError,
  SocketUnauthenticatedError,
} from './errors';
import type { PrincipalSockets } from './principal-sockets';
import { principalFor } from './subscription-book';
import type { SyncAuthenticator, SyncGrant } from './sync-auth';
import { upgradeOrigin } from './sync-origin';
import { toWireError } from './sync-protocol';
import type { AcceptBudget, Rng } from './thundering-herd';

/**
 * What the upgrade hands the socket. It carries no actor: the grant does, and one identity written
 * in two places is two that disagree the moment a re-auth renews one of them.
 */
export interface WsData {
  readonly socketId: string;
  /**
   * `?build=` off the dial, or this node's own id when the dial carried none. A starting value,
   * not the verdict: the `hello` frame's `buildId` overwrites it (`SyncSocket.sawHello`), so a
   * client that names its build only in the frame — the documented place — is not deemed current
   * forever for having sent no query.
   */
  readonly clientBuildId: string;
  /**
   * The caller's address, resolved here once (`clientAddressOf`); `null` when nothing can say.
   * Optional only for a socket a host builds without this upgrade (a test harness).
   */
  readonly clientAddress?: string | null;
}

/** Structural view of `Bun.serve`'s server object; keeps this module free of a Bun import. */
export interface UpgradeTarget {
  upgrade(request: Request, options: { data: WsData }): boolean;
  /**
   * The peer's SOCKET address, as `Bun.serve`'s server answers it — what decides who is told the
   * health detail. `null` when the host cannot say, which is told the verdict only.
   */
  requestIP(request: Request): { readonly address: string } | null;
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
  /**
   * Exact origins a page may dial from — `APP_URL`'s. Declared, they are the WHOLE list: the
   * origin the node sees is `Host`-derived and is admitted only when nothing is declared
   * (`sync-origin.ts`).
   */
  readonly allowedOrigins?: readonly string[] | undefined;
  /**
   * Who the caller is, for keying an anonymous reader's rate limit: the deployment's own rule —
   * `@ultimat3/http`'s `clientAddress()` under its `TRUSTED_PROXY_HOPS`, injected by the boot so
   * this package reads no proxy header itself. Absent, the socket's address is the caller.
   */
  readonly clientAddressOf?:
    | ((request: Request, socketAddress: string | null) => string | null)
    | undefined;
  /** The `Host`-derived origin admitted beside a declared list too — `x dev` only. */
  readonly admitReachedOrigin?: boolean | undefined;
  /**
   * Peers told the whole health report — address classes or exact IP literals, the app's
   * `http.healthDetailPeers`. Everyone else gets `{ state, ready, role }`.
   */
  readonly healthDetailPeers: readonly string[];
  /**
   * Recorded BEFORE `server.upgrade`, because Bun runs `websocket.open` synchronously inside it
   * (measured on bun 1.4.0) and `open` is where the node reads this grant to build the socket's
   * actor. Recorded after, every authenticated socket carried `actor: null` — the topic guard,
   * `authorize`, `visible` and the per-tenant cap all deciding about nobody — and it never
   * repaired, because the re-auth sweep only visits grants with an `expiresAt`.
   */
  onGranted(socketId: string, grant: SyncGrant): void;
  /**
   * The grant given back on the one path that will never open a socket. Recording first is only
   * safe because this exists: nothing but a `close` callback deletes a grant, and there is no
   * callback for an upgrade that never took. Required, not optional — a host that reserves and
   * cannot release is a leak the type refuses rather than a rule a reviewer has to remember. The
   * same "reserve, then release" shape `channel.ts` uses for a topic slot.
   */
  onUngranted(socketId: string): void;
  /**
   * One principal's sockets on this node, keyed as the live-query principal is. Admitted right
   * before `server.upgrade`; `onUngranted` and the socket's close give the slot back.
   */
  readonly principals?: PrincipalSockets | undefined;
}

/**
 * `undefined` means the upgrade took and Bun owns the connection now. Async because `authenticate`
 * is: the credential is decided *before* `server.upgrade`, so a refused one never costs a websocket.
 *
 * Every answer that is NOT a socket is `no-store`, whatever it is: a response with no
 * `cache-control` is one a CDN applies its own default TTL to, and this role sits behind an
 * operator's routing rule that can send it what it does not serve — a page asset misrouted here
 * came back `404 not found`, and the edge kept that miss for four hours after the fix.
 */
export async function handleUpgrade(
  deps: UpgradeDeps,
  request: Request,
  server: UpgradeTarget,
): Promise<Response | undefined> {
  const response = await answerUpgrade(deps, request, server);
  if (response !== undefined && !response.headers.has('cache-control')) {
    response.headers.set('cache-control', 'no-store');
  }
  return response;
}

async function answerUpgrade(
  deps: UpgradeDeps,
  request: Request,
  server: UpgradeTarget,
): Promise<Response | undefined> {
  const url = new URL(request.url);
  // Health is the process's, readiness is this node's: a draining node stays healthy while it hands
  // its sockets to the rest of the fleet.
  if (url.pathname === '/healthz') return health(deps, request, server, healthzPayload());
  if (url.pathname === '/readyz') {
    const payload = readyzPayload({ deep: url.searchParams.get('deep') === '1' });
    return health(deps, request, server, deps.ready() ? payload : { ...payload, status: 503 });
  }
  if (url.pathname !== deps.path) return new Response('not found', { status: 404 });
  // First, and before anything is spent: a foreign page is refused whatever the node's load.
  const origin = upgradeOrigin(request, url, deps.allowedOrigins ?? [], deps.admitReachedOrigin);
  if (!origin.ok) {
    const asked = { asked: request.headers.get('origin'), admitted: admittedList(deps) };
    return wireErrorResponse(
      403,
      new SocketOriginRefusedError({ reason: origin.reason, ...asked }),
    );
  }
  // The count and readiness. Decided before `authenticate` so a full node costs no token service
  // call.
  if (deps.socketCount() >= deps.maxConnections || !deps.ready()) return shed(deps);
  // The RATE is RESERVED here and REFUNDED on every exit that takes no socket. Reserved first, so a
  // reconnect herd reaches `authenticate` bounded by the burst — the token service is the first
  // thing a herd would otherwise flatten. Refunded, because spent-and-kept, one client dialling
  // with no credential drained the bucket and every signed-in reconnect behind it was shed.
  if (!deps.accept.tryAccept()) return shed(deps);
  const refund = (): void => deps.accept.refund();
  let grant: SyncGrant | null = null;
  if (deps.authenticate) {
    try {
      grant = await deps.authenticate(request);
    } catch (error) {
      // A failure is not a denial. The token service timing out must not read to a client as "you
      // may not connect" — it is told to come back, and this node is the one that pages.
      reportError(error, { source: 'realtime', scope: { operation: 'sync.authenticate' } });
      refund();
      return wireErrorResponse(
        503,
        new SocketAuthUnavailableError({ detail: 'see the node log for the cause' }),
      );
    }
    // The decision, made before a socket exists: an upgrade is the cheapest thing to refuse and the
    // most expensive thing to take back.
    if (grant === null) {
      refund();
      return wireErrorResponse(
        401,
        new SocketUnauthenticatedError({ reason: 'authenticate() resolved no actor' }),
      );
    }
  }
  // BOTH facts asked again, because `authenticate` is app code and awaiting it is awaiting a token
  // service: everything this request read above is history by the time it gets here.
  //
  // `ready`, because SIGTERM can land while the request is parked and the `accept` phase is over
  // by now — upgrading then is the one socket that phase exists to refuse, on a node the load
  // balancer has already been told is out.
  //
  // The socket COUNT, for the same reason and it was the half that was missing: a restart storm
  // dials every client of a dead node at this one at once, each parked in the token service having
  // passed the cap while the node still held nothing — so a node capped at 2 accepted as many
  // sockets as there were parked requests, and `maxConnections` bounded nothing that a herd could
  // reach. Sound because there is no await between this line and `server.upgrade`, and the count
  // moves INSIDE it: Bun runs `websocket.open` synchronously there, which is where `sockets.add`
  // runs.
  if (!deps.ready() || deps.socketCount() >= deps.maxConnections) {
    refund();
    return shed(deps);
  }
  const data: WsData = {
    socketId: deps.newSocketId(),
    // The node's own id is "not skewed until the hello says so", never "current forever".
    clientBuildId: url.searchParams.get('build') ?? deps.buildId,
    clientAddress: callerAddress(deps, request, server),
  };
  // Beside the count recheck and for its reason: no await between this and `server.upgrade`, so a
  // herd of one principal parked in `authenticate` cannot all pass one count.
  const principal = principalFor(grant?.actor ?? null, data.clientAddress ?? null);
  if (deps.principals !== undefined && !deps.principals.admit(data.socketId, principal)) {
    refund();
    return wireErrorResponse(
      429,
      new SocketLimitError({ principal, limit: deps.principals.limitFor(principal) }),
    );
  }
  // Before the upgrade, never after: `server.upgrade` runs `websocket.open` synchronously and does
  // not return until it has, so a grant recorded on the next line is one the socket was already
  // built without.
  if (grant) deps.onGranted(data.socketId, grant);
  let upgraded: boolean;
  try {
    upgraded = server.upgrade(request, { data });
  } catch (error) {
    // The other exit that never opens a socket, and the one the `false` branch below hid. Bun runs
    // `websocket.open` synchronously inside `upgrade`, so ANYTHING that throws in there — a socket
    // refusing its own ceiling, an app-supplied registry, an `open` a later change adds work to —
    // comes out here, with no `close` callback behind it. Unreleased, that is one `GrantBook` entry
    // per connection ATTEMPT, and an unreapable one: `sweepGrants` only visits a grant carrying an
    // `expiresAt`, which `authenticate: async () => ({ actor })` does not produce. Measured, 20
    // failing upgrades left 20 grants. Rethrown untouched — the throw is the operator's diagnosis,
    // and this line owes it the release, not a verdict.
    deps.onUngranted(data.socketId);
    refund();
    throw error;
  }
  if (!upgraded) {
    deps.onUngranted(data.socketId);
    refund();
    return new Response('expected websocket', { status: 426 });
  }
  return undefined;
}

/**
 * What a proxy writes. Any one of them means the socket's address is the proxy's, not the
 * caller's — and a proxy that writes none of them is indistinguishable from a direct peer, so a
 * header-less proxy must not route the health paths at all.
 */
const FORWARDED_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
  'via',
] as const;

/**
 * The STATUS is everyone's, which is all a probe reads. The body beyond the verdict is for a peer
 * the app listed, on a DIRECT socket: these paths answer before the origin check, the accept
 * budget and `authenticate`. This node declares no trusted proxy, so a request that says it was
 * forwarded is never told the detail — a proxy on this box makes every caller's socket loopback.
 */
function health(
  deps: UpgradeDeps,
  request: Request,
  server: UpgradeTarget,
  payload: HealthPayload,
): Response {
  const forwarded = FORWARDED_HEADERS.some((header) => request.headers.has(header));
  const detailed =
    !forwarded &&
    healthPeerListed(deps.healthDetailPeers, server.requestIP(request)?.address ?? null);
  return new Response(JSON.stringify(healthBody(payload.body, 'sync', detailed)), {
    status: payload.status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

function callerAddress(deps: UpgradeDeps, request: Request, server: UpgradeTarget): string | null {
  const socketAddress = server.requestIP(request)?.address ?? null;
  return deps.clientAddressOf === undefined
    ? socketAddress
    : deps.clientAddressOf(request, socketAddress);
}

/** Load shedding with a delay attached: refusing without one just moves the herd next door. */
function shed(deps: UpgradeDeps): Response {
  return new Response('retry', {
    status: 503,
    headers: { 'retry-after-ms': String(deps.accept.retryAfterMs(deps.rng)) },
  });
}

/** What the refusal says this node admits: the declared list, and under `x dev` the reached-on origin. */
function admittedList(deps: UpgradeDeps): readonly string[] {
  const declared = deps.allowedOrigins ?? [];
  if (declared.length === 0 || deps.admitReachedOrigin !== true) return declared;
  return [...declared, 'the origin it was reached on'];
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
