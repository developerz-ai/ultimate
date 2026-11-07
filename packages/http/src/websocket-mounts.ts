// Several websocket mounts on ONE listener. `Bun.serve` takes one `websocket` handler set for every
// socket it opens, so the mounts are joined here: an upgrade is routed by path, and each socket's
// events go back to the mount that upgraded it — keyed by the `data` object that mount handed
// `server.upgrade`, which Bun returns as `ws.data`. No mount's socket is wrapped or proxied.

import { assert } from '@ultimat3/core';
import type { UpgradeTarget, WebSocketMount } from './server';

/**
 * A mount's handler set with Bun's optional `drain`: the sync node answers it with its
 * backpressure gap repair, and a join that dropped it left a refused frame's socket gapped.
 */
export type MountHandlers<TSocket> = WebSocketMount<TSocket>['websocket'] & {
  drain?(ws: TSocket): void;
};

/** What `httpServer` dispatches: every path the mounts own, one fetch, one handler set. */
export interface JoinedWebSocketMounts {
  readonly paths: ReadonlySet<string>;
  fetch(
    request: Request,
    server: UpgradeTarget,
  ): Promise<Response | undefined> | Response | undefined;
  readonly websocket: MountHandlers<{ readonly data: unknown }>;
}

/** Bun's per-listener knobs, joined so no mount gets less than it declared. */
function joinedLimits(mounts: readonly WebSocketMount<never>[]) {
  const max = (pick: (mount: WebSocketMount<never>) => number | undefined): number | undefined => {
    const values = mounts.map(pick).filter((value): value is number => value !== undefined);
    return values.length === 0 ? undefined : Math.max(...values);
  };
  const idleTimeout = max((mount) => mount.websocket.idleTimeout);
  const backpressureLimit = max((mount) => mount.websocket.backpressureLimit);
  const maxPayloadLength = max((mount) => mount.websocket.maxPayloadLength);
  const sendPings = mounts.some((mount) => mount.websocket.sendPings === true);
  return {
    ...(idleTimeout === undefined ? {} : { idleTimeout }),
    ...(backpressureLimit === undefined ? {} : { backpressureLimit }),
    ...(maxPayloadLength === undefined ? {} : { maxPayloadLength }),
    ...(sendPings ? { sendPings } : {}),
  };
}

/**
 * The mounts, joined. Two at one path is `X_INVARIANT` here — the same fact `httpServer` refuses
 * between a mount and a route. The listener's limits are the widest any mount declared, so Bun
 * enforces only those: a mount whose own bound is tighter (the sync node's `maxFrameBytes`, the
 * device socket's frame cap) refuses past it in its own `message`, never through Bun alone.
 */
export function joinWebSocketMounts(
  mounts: readonly WebSocketMount<never>[],
): JoinedWebSocketMounts {
  const byPath = new Map<string, WebSocketMount<never>>();
  for (const mount of mounts) {
    assert(
      !byPath.has(mount.path),
      `two websocket mounts claim ${mount.path}, and a path is answered by one of them`,
      'x routes --json   # then move one mount to a path of its own',
    );
    byPath.set(mount.path, mount);
  }
  // A socket's owner, by the identity of the data its mount upgraded it with.
  const owners = new WeakMap<object, WebSocketMount<never>>();
  const ownerOf = (ws: { readonly data: unknown }): WebSocketMount<never> | undefined =>
    typeof ws.data === 'object' && ws.data !== null ? owners.get(ws.data) : undefined;
  // `never` is each mount's own socket type, unknown to this file: the socket handed back is the
  // one that mount's upgrade produced, so the widening below is the only way to return it.
  const hand = (ws: { readonly data: unknown }): never => ws as never;
  // Read through the wider type: `drain` is optional, so every mount's handler set is one.
  const handlersOf = (mount?: WebSocketMount<never>): MountHandlers<never> | undefined =>
    mount?.websocket;
  return {
    paths: new Set(byPath.keys()),
    fetch(request, server) {
      const mount = byPath.get(new URL(request.url).pathname);
      if (mount === undefined) return new Response('not found', { status: 404 });
      const recording: UpgradeTarget = {
        upgrade(upgraded, options) {
          const { data } = options;
          assert(
            typeof data === 'object' && data !== null,
            `the websocket mount at ${mount.path} upgraded with data that is not an object, so its socket cannot be routed back to it`,
            'server.upgrade(request, { data: { socketId } })   # an object, in the mount at that path',
          );
          owners.set(data, mount);
          return server.upgrade(upgraded, options);
        },
        requestIP: (asked) => server.requestIP(asked),
      };
      return mount.fetch(request, recording);
    },
    websocket: {
      open: (ws) => ownerOf(ws)?.websocket.open(hand(ws)),
      message: (ws, message) => ownerOf(ws)?.websocket.message(hand(ws), message),
      close: (ws) => ownerOf(ws)?.websocket.close(hand(ws)),
      // Present only when a mount answers it: Bun calls it once a socket's buffer can take frames.
      ...(mounts.some((mount) => handlersOf(mount)?.drain !== undefined)
        ? { drain: (ws) => handlersOf(ownerOf(ws))?.drain?.(hand(ws)) }
        : {}),
      ...joinedLimits(mounts),
    },
  };
}
