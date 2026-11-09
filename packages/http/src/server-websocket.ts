// What `httpServer` serves for its `websocket:` option — one mount or a list — as the ONE shape its
// listener dispatches: every owned path, one fetch, one handler set. A lone mount is handed through
// unwrapped (no socket of the sync node's pays for a join it does not need); two or more are joined
// by `joinWebSocketMounts`, which routes each upgrade, and each socket's frames, to its own mount.

import type { WebSocketMount } from './server';
import { type JoinedWebSocketMounts, joinWebSocketMounts } from './websocket-mounts';

/** `ServerOptions.websocket`: the sync node's socket, a device link, or both on one listener. */
export type WebSocketOption = WebSocketMount | readonly WebSocketMount[];

const isList = (option: WebSocketOption): option is readonly WebSocketMount[] =>
  Array.isArray(option);

/**
 * The served mounts, or `undefined` when there are none — then the listener opens no websocket at
 * all, as it did before the option existed. `assertFree` is asked about EVERY path before anything
 * is joined: a static route on the second mount's path shadows it exactly as it would the first.
 */
export function serverWebSockets(
  option: WebSocketOption | undefined,
  assertFree: (path: string) => void,
): JoinedWebSocketMounts | undefined {
  const mounts = option === undefined ? [] : isList(option) ? option : [option];
  for (const mount of mounts) assertFree(mount.path);
  const [only] = mounts;
  if (only === undefined) return undefined;
  if (mounts.length > 1) return joinWebSocketMounts(mounts);
  return {
    paths: new Set([only.path]),
    fetch: (request, server) => only.fetch(request, server),
    // `never` is the mount's own socket type: the socket Bun hands back is the one its upgrade made.
    websocket: only.websocket as JoinedWebSocketMounts['websocket'],
  };
}
