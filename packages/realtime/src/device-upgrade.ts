// Whether a device may have a socket, decided entirely BEFORE `server.upgrade`: origin, load, the
// bearer token (bounded by a deadline, so a token service that hangs cannot park upgrades without
// end), expiry and the per-actor cap. A refused upgrade never costs a websocket.

import type { Actor, Clock } from '@ultimat3/core';
import { reportError } from '@ultimat3/core';
import {
  deviceAuthUnavailable,
  deviceOriginRefused,
  deviceSocketLimit,
  deviceUnauthenticated,
} from './device-errors';
import type { PrincipalSockets } from './principal-sockets';
import { toWireError } from './sync-protocol';
import type { AcceptBudget, Rng, Scheduler } from './thundering-herd';

/** What a token resolves to: who the device acts as, which device it is, and until when. */
export interface DeviceGrant {
  readonly actor: Actor;
  /** The app's own id for the device — what `request(ctx, deviceId, …)` addresses. */
  readonly deviceId: string;
  /** Epoch ms. Past it the upgrade is refused, and an open socket is closed by the sweep. */
  readonly expiresAt?: number | undefined;
}

/** How the upgrade arrived, as far as a token decision may read it — never the raw headers. */
export interface DeviceUpgradeFacts {
  /** The peer's socket address; `null` when the host cannot say. */
  readonly address: string | null;
  readonly userAgent: string | null;
  readonly path: string;
}

/** `null` for a malformed, unknown, revoked or expired token: all one indistinguishable 401. */
export type DeviceTokenResolver = (
  token: string,
  facts: DeviceUpgradeFacts,
) => Promise<DeviceGrant | null> | DeviceGrant | null;

/** What the upgrade hands the socket. The grant rides here: this socket kind has no re-auth. */
export interface DeviceWsData {
  readonly socketId: string;
  readonly grant: DeviceGrant;
  /** `grant.actor.orgId`, or `''` for an actor with none — the key every lookup is scoped by. */
  readonly tenant: string;
}

/** Structural view of `Bun.serve`'s server, as much of one as the upgrade reads. */
export interface DeviceUpgradeTarget {
  upgrade(request: Request, options: { data: DeviceWsData }): boolean;
  requestIP(request: Request): { readonly address: string } | null;
}

export interface DeviceUpgradeDeps {
  readonly path: string;
  readonly allowedOrigins: readonly string[];
  readonly resolveToken: DeviceTokenResolver;
  readonly accept: AcceptBudget;
  readonly principals: PrincipalSockets;
  readonly rng: Rng;
  readonly clock: Clock;
  readonly schedule: Scheduler;
  readonly authDeadlineMs: number;
  readonly maxPendingUpgrades: number;
  /** Bound to a bus and not draining. Asked again after the token await. */
  accepting(): boolean;
  newSocketId(): string;
  /** Upgrades parked in `resolveToken` right now — read and moved by this function alone. */
  readonly parked: { count: number };
}

/** The tenant key of an actor: its org, or `''` for an app with no tenancy. */
export const tenantOf = (actor: Actor): string => actor.orgId ?? '';

/** The per-actor cap key: an actor's id within its tenant, never request text. */
const principalOf = (actor: Actor): string =>
  `actor:${JSON.stringify([tenantOf(actor), actor.id])}`;

/** `Authorization: Bearer <token>`, scheme case-insensitive; anything else is no token. */
export function bearerToken(header: string | null): string | null {
  const match = header === null ? null : /^Bearer[ ]+([^ ]+)[ ]*$/i.exec(header);
  return match?.[1] ?? null;
}

const SHED_STATUS = 503;

/** `undefined`: the upgrade took and Bun owns the connection. Every other answer is `no-store`. */
export async function answerDeviceUpgrade(
  deps: DeviceUpgradeDeps,
  request: Request,
  server: DeviceUpgradeTarget,
): Promise<Response | undefined> {
  // A browser says where it is; a device does not. An Origin is a page — refused before anything
  // is spent, unless the declaration lists that exact origin.
  const origin = request.headers.get('origin');
  if (origin !== null && !deps.allowedOrigins.includes(URL.parse(origin)?.origin ?? '')) {
    return refusal(403, deviceOriginRefused(deps.path, deps.allowedOrigins));
  }
  const token = bearerToken(request.headers.get('authorization'));
  if (token === null) {
    return refusal(
      401,
      deviceUnauthenticated(deps.path, 'no Authorization: Bearer token'),
      'Bearer',
    );
  }
  if (!deps.accepting() || deps.parked.count >= deps.maxPendingUpgrades) return shed(deps);
  if (!deps.accept.tryAccept()) return shed(deps);
  const facts: DeviceUpgradeFacts = Object.freeze({
    address: server.requestIP(request)?.address ?? null,
    userAgent: request.headers.get('user-agent'),
    path: deps.path,
  });
  const decided = await decide(deps, token, facts);
  if (decided instanceof Response) {
    deps.accept.refund();
    return decided;
  }
  // Asked again: the await above was app code, and SIGTERM may have landed while it ran.
  if (!deps.accepting()) {
    deps.accept.refund();
    return shed(deps);
  }
  const data: DeviceWsData = {
    socketId: deps.newSocketId(),
    grant: decided,
    tenant: tenantOf(decided.actor),
  };
  // No await between this and `server.upgrade`, so a herd of one actor cannot all pass one count.
  if (!deps.principals.admit(data.socketId, principalOf(decided.actor))) {
    deps.accept.refund();
    return refusal(429, deviceSocketLimit(deps.path, deps.principals.max));
  }
  let upgraded = false;
  try {
    upgraded = server.upgrade(request, { data });
  } finally {
    if (!upgraded) {
      deps.principals.release(data.socketId);
      deps.accept.refund();
    }
  }
  return upgraded
    ? undefined
    : new Response('expected websocket', { status: 426, headers: NO_STORE });
}

/** The grant, or the refusal: a resolver that raises or outlives the deadline is a 503, not a 401. */
async function decide(
  deps: DeviceUpgradeDeps,
  token: string,
  facts: DeviceUpgradeFacts,
): Promise<DeviceGrant | Response> {
  deps.parked.count += 1;
  let cancel: () => void = () => undefined;
  try {
    const deadline = new Promise<'deadline'>((resolve) => {
      cancel = deps.schedule(() => resolve('deadline'), deps.authDeadlineMs);
    });
    const grant = await Promise.race([Promise.resolve(deps.resolveToken(token, facts)), deadline]);
    if (grant === 'deadline') {
      return refusal(
        SHED_STATUS,
        deviceAuthUnavailable(`no answer within ${deps.authDeadlineMs}ms`),
      );
    }
    if (grant === null) {
      return refusal(
        401,
        deviceUnauthenticated(deps.path, 'resolveToken() resolved no grant'),
        'Bearer error="invalid_token"',
      );
    }
    if (grant.expiresAt !== undefined && !(grant.expiresAt > deps.clock.now().getTime())) {
      return refusal(
        401,
        deviceUnauthenticated(deps.path, 'the grant resolveToken() returned has expired'),
        'Bearer error="invalid_token"',
      );
    }
    if (typeof grant.deviceId !== 'string' || grant.deviceId.length === 0) {
      return refusal(
        401,
        deviceUnauthenticated(deps.path, 'the grant resolveToken() returned names no deviceId'),
        'Bearer error="invalid_token"',
      );
    }
    return grant;
  } catch (error) {
    reportError(error, { source: 'realtime', scope: { operation: 'device.resolve_token' } });
    return refusal(SHED_STATUS, deviceAuthUnavailable('see the node log for the cause'));
  } finally {
    cancel();
    deps.parked.count -= 1;
  }
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

/** The sync node's refusal body, and the bearer challenge `@ultimat3/http`'s mounts send. */
function refusal(status: number, error: unknown, challenge?: string): Response {
  return new Response(JSON.stringify({ error: toWireError(error) }), {
    status,
    headers: {
      'content-type': 'application/json',
      ...NO_STORE,
      ...(challenge === undefined ? {} : { 'www-authenticate': challenge }),
    },
  });
}

/** Load shed with a jittered delay — refusing without one only moves the herd next door. */
function shed(deps: DeviceUpgradeDeps): Response {
  return new Response('retry', {
    status: SHED_STATUS,
    headers: { ...NO_STORE, 'retry-after-ms': String(deps.accept.retryAfterMs(deps.rng)) },
  });
}
