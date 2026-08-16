// Binding a `sync` node to a real socket, and to the process lifecycle. Kept out of `sync-node.ts`
// so the node itself stays testable with no server: this file is the only place realtime calls
// `Bun.serve`, and the only thing in the package that knows a port exists.

import { markListening, onShutdown } from '@ultimat3/core';
import type { SyncNode } from './sync-node';

export interface ListenOptions {
  readonly port?: number;
}

export interface SyncListener {
  /** The bound websocket origin, e.g. `ws://localhost:3001`. With `port: 0` only the OS knows it. */
  readonly url: string;
  stop(): void;
}

/**
 * Binds the node to `Bun.serve` and wires SIGTERM to `drain()`. Kept tiny so the node itself stays
 * testable without a server.
 */
export function listenSyncNode(node: SyncNode, options: ListenOptions = {}): SyncListener {
  const server = Bun.serve({
    port: options.port ?? 3001,
    fetch: node.fetch,
    websocket: node.websocket,
  });
  // Same rule as @ultimat3/http: every socket the framework opens announces itself, so a request
  // back to it is recognisably this process calling itself rather than egress.
  const stopListening = markListening(server.url.origin);
  // Unregistered by `stop()`: a hook left behind after the listener is gone drains a node that is
  // already stopped, and the next process-wide shutdown hangs on it.
  const unregister = onShutdown('realtime:sync', async () => {
    await node.drain();
    await node.stop();
    server.stop();
    stopListening();
  });
  return {
    url: websocketOrigin(server.url),
    stop: () => {
      unregister();
      server.stop();
      stopListening();
    },
  };
}

/**
 * The listener reports where it actually landed: a caller asking for `port: 0` cannot guess the
 * port, and a guessed URL is a client that connects to someone else. Swapped on the URL's
 * protocol, never on the string — a hostname is allowed to contain "http".
 */
function websocketOrigin(url: URL): string {
  const ws = new URL(url);
  ws.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return ws.origin;
}
