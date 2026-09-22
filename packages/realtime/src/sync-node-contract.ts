// What a `sync` node IS, as types: the options `createSyncNode` takes, the node it returns and the
// socket Bun hands its handlers. Apart from `sync-node.ts` so the lifecycle there stays under the
// file ceiling, and so a host can name the shapes without reading the lifecycle.

import type { Clock } from '@ultimat3/core';
import type { ChannelHub } from './channel';
import type { Transport } from './fanout';
import type { LiveQueryRegistry } from './live-query';
import type { PresenceRegistry } from './presence';
import type { SocketRegistry, WsLike } from './socket';
import type { SyncAuthenticator } from './sync-auth';
import type { UpgradeTarget, WsData } from './sync-upgrade';
import type { AcceptBudget, DrainedSocket, Rng } from './thundering-herd';

export type SyncWs = WsLike & { readonly data: WsData };

export interface SyncNodeOptions {
  readonly hub: ChannelHub;
  readonly registry: LiveQueryRegistry;
  readonly transport: Transport;
  readonly buildId: string;
  readonly presence?: PresenceRegistry;
  readonly sockets?: SocketRegistry;
  readonly accept?: AcceptBudget;
  /** Concurrent sockets this node will hold. The count the accept budget does not bound. */
  readonly maxConnections?: number;
  /** Inbound bytes one frame may carry, handed to whatever server mounts `websocket`. */
  readonly maxFrameBytes?: number;
  /** Sustained inbound frames one socket may have routed per second. */
  readonly maxFramesPerSecond?: number;
  /** Burst allowance on that rate, per socket. */
  readonly frameBurst?: number;
  /**
   * When a socket starts dropping frames, and how many drops close it. On `SyncSocket` too, but
   * this node builds every socket it holds — so unforwarded they were reachable only by abandoning
   * `createSyncNode`, and a dropped channel frame is the one loss nothing replays.
   */
  readonly maxBufferedBytes?: number;
  readonly maxDroppedFrames?: number;
  /**
   * How long a socket may route no frame before this node evicts it. Every ceiling on a socket
   * `sync` builds has to be reachable from here, and this one was not: `SocketRegistry`'s default
   * was only settable by constructing the registry yourself, and nothing swept it either way.
   */
  readonly idleTimeoutMs?: number;
  /**
   * Who is dialling. Injected because `sync` owns no business logic and
   * imports no authenticator, so an app supplies the one function that turns an upgrade request
   * into an actor — from `@ultimat3/auth` or from anywhere else.
   *
   * **Omitted, every socket on this node is anonymous** and every policy downstream — the topic
   * guard, `authorize`, `visible`, the per-tenant subscription cap — decides against `null`. That
   * is a single-tenant node, and `start()` says so in the log.
   */
  readonly authenticate?: SyncAuthenticator;
  /** How often an expired grant is re-decided. The clock a socket's authority runs on. */
  readonly reauthenticateIntervalMs?: number;
  readonly clock?: Clock;
  readonly rng?: Rng;
  /** WS endpoint. One path, no negotiation — the protocol version lives in the frames. */
  readonly path?: string;
  readonly drainSpreadMs?: number;
}

export interface SyncNode {
  readonly sockets: SocketRegistry;
  readonly ready: boolean;
  /** The one path it answers an upgrade on: a HOST has to route it, and must not restate it. */
  readonly path: string;
  start(): Promise<void>;
  /**
   * Refuse new connections, keep every one this node holds. The SIGTERM `accept` phase calls it —
   * `/readyz` answers 503 so the load balancer stops routing here, and an upgrade arriving in the
   * meantime is shed with a retry delay instead of landing on a process that is going away. It is
   * NOT `stop()`: a draining node still owes its clients their patches, and `stop()` releases the
   * change subscription that carries them.
   */
  stopAccepting(): void;
  stop(): Promise<void>;
  /**
   * Async because `authenticate` is: the credential is decided *before* `server.upgrade`, so a
   * refused one never costs a websocket. Bun's `fetch` may return a promise, and an upgrade that
   * awaits first is still an upgrade.
   */
  fetch(request: Request, server: UpgradeTarget): Promise<Response | undefined>;
  readonly websocket: {
    idleTimeout: number;
    backpressureLimit: number;
    /** Inbound ceiling. Declared here so every host that mounts this handler inherits it. */
    maxPayloadLength: number;
    sendPings: boolean;
    open(ws: SyncWs): void;
    message(ws: SyncWs, message: string | Uint8Array): void;
    /** Bun calls it when a backed-up socket has drained: owed `replay-gap` frames go out here. */
    drain(ws: SyncWs): void;
    close(ws: SyncWs): void;
  };
  /** Sends every client a distinct reconnect delay, then closes. Returns the plan for tests/logs. */
  drain(options?: { graceMs?: number }): Promise<readonly DrainedSocket[]>;
}
