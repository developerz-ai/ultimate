// The `sync` role. Accepts WS connections, routes frames, drains gracefully.
//
// Stateless by construction: the only per-node memory is the socket table. No sticky sessions — a
// client may reconnect to any node and resume from its cursor, which is why drain is allowed to
// redistribute connections at all.

import {
  type Clock,
  healthzPayload,
  logger,
  markListening,
  markReady,
  onShutdown,
  readyzPayload,
  systemClock,
  uuid,
} from '@ultimat3/core';
import type { ChannelHub, Topic } from './channel';
import { topic as makeTopic } from './channel';
import type { Transport, TransportSubscription } from './fanout';
import type { JsonValue, Row } from './json';
import type { LiveQueryRegistry } from './live-query';
import type { PresenceRegistry } from './presence';
import { CHANGE_SUBJECT_PREFIX, parseChange } from './replicator';
import { CLOSE, SocketRegistry, SyncSocket, type WsLike } from './socket';
import { decode, type Frame, PROTOCOL_VERSION, toWireError } from './sync-protocol';
import { AcceptBudget, drainPlan, type Rng, reconnectFrame } from './thundering-herd';

export interface WsData {
  readonly socketId: string;
  readonly clientBuildId: string;
  readonly actorId: string | null;
}

export type SyncWs = WsLike & { readonly data: WsData };

/** Server-authoritative mutation execution. Injected: `sync` never owns business logic. */
export type MutationHandler = (args: {
  socket: SyncSocket;
  name: string;
  key: string;
  seq: number;
  input: JsonValue;
}) => Promise<{ lsn?: string | null; entity?: string; row?: Row | null }>;

export interface SyncNodeOptions {
  readonly hub: ChannelHub;
  readonly registry: LiveQueryRegistry;
  readonly transport: Transport;
  readonly buildId: string;
  readonly presence?: PresenceRegistry;
  readonly sockets?: SocketRegistry;
  readonly accept?: AcceptBudget;
  readonly onMutate?: MutationHandler;
  readonly clock?: Clock;
  readonly rng?: Rng;
  /** WS endpoint. One path, no negotiation — the protocol version lives in the frames. */
  readonly path?: string;
  readonly drainSpreadMs?: number;
}

/** Structural view of `Bun.serve`'s server object; keeps this module free of a Bun import. */
export interface UpgradeTarget {
  upgrade(request: Request, options: { data: WsData }): boolean;
}

export interface SyncNode {
  readonly sockets: SocketRegistry;
  readonly ready: boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
  fetch(request: Request, server: UpgradeTarget): Response | undefined;
  readonly websocket: {
    idleTimeout: number;
    backpressureLimit: number;
    publishToSelf: boolean;
    sendPings: boolean;
    open(ws: SyncWs): void;
    message(ws: SyncWs, message: string | Uint8Array): void;
    close(ws: SyncWs): void;
  };
  /** Sends every client a distinct reconnect delay, then closes. Returns the plan for tests/logs. */
  drain(options?: { graceMs?: number }): Promise<readonly { socketId: string; afterMs: number }[]>;
}

export function createSyncNode(options: SyncNodeOptions): SyncNode {
  const sockets =
    options.sockets ?? new SocketRegistry({ ...(options.clock ? { clock: options.clock } : {}) });
  const clock = options.clock ?? systemClock;
  const accept = options.accept ?? new AcceptBudget({ perSecond: 500, burst: 2000, clock });
  const path = options.path ?? '/_x/sync';
  let ready = false;
  let changes: TransportSubscription | null = null;

  const routeFrame = async (socket: SyncSocket, frame: Frame): Promise<void> => {
    socket.touch();
    switch (frame.type) {
      case 'hello': {
        socket.send({
          type: 'hello',
          v: PROTOCOL_VERSION,
          buildId: options.buildId,
          sessionId: socket.id,
          actorId: socket.actorId,
          resume: [],
        });
        if (socket.skewed) {
          socket.send({ type: 'update-available', v: PROTOCOL_VERSION, buildId: options.buildId });
        }
        return;
      }
      case 'subscribe': {
        if (frame.target.kind === 'topic') {
          const name = makeTopic(...frame.target.topic.split('.'));
          if (frame.op === 'drop') options.hub.unsubscribe(socket, name);
          else await options.hub.subscribe(socket, name);
          if (frame.op === 'add' && options.presence) {
            socket.send(await options.presence.syncFrame(name));
          }
          return;
        }
        if (frame.op === 'drop') {
          options.registry.unsubscribe(frame.sid);
          return;
        }
        const { frame: reply } = await options.registry.subscribe({
          socket,
          name: frame.target.qid,
          input: frame.target.input,
          sid: frame.sid,
          cursor: frame.target.cursor,
        });
        socket.send(reply);
        return;
      }
      case 'mutate': {
        if (!options.onMutate) {
          socket.send({
            type: 'ack',
            v: PROTOCOL_VERSION,
            ref: frame.key,
            lsn: null,
            error: toWireError({
              code: 'X_NOT_IMPLEMENTED',
              cause: 'this sync node was started without a mutation handler',
              fix: 'pass onMutate to createSyncNode({ onMutate })',
            }),
          });
          return;
        }
        const result = await options.onMutate({
          socket,
          name: frame.name,
          key: frame.key,
          seq: frame.seq,
          input: frame.input,
        });
        socket.send({
          type: 'ack',
          v: PROTOCOL_VERSION,
          ref: frame.key,
          lsn: result.lsn ?? null,
          error: null,
        });
        if (result.entity !== undefined) {
          socket.send({
            type: 'rebase',
            v: PROTOCOL_VERSION,
            key: frame.key,
            entity: result.entity,
            strategy: 'server-wins',
            row: result.row ?? null,
          });
        }
        return;
      }
      // Server-authored frames are never received from a client.
      case 'snapshot':
      case 'patch':
      case 'ack':
      case 'rebase':
      case 'presence':
      case 'reconnect':
      case 'update-available':
        return;
    }
  };

  return {
    sockets,

    get ready(): boolean {
      return ready;
    },

    async start(): Promise<void> {
      changes = await options.transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
        const change = parseChange(payload);
        if (change) void options.registry.deliver(change);
      });
      ready = true;
      markReady();
      logger.info('sync node ready', { buildId: options.buildId, path });
    },

    async stop(): Promise<void> {
      ready = false;
      changes?.unsubscribe();
      changes = null;
    },

    fetch(request: Request, server: UpgradeTarget): Response | undefined {
      const url = new URL(request.url);
      // Health is the process's, readiness is this node's: a draining node stays healthy while it
      // hands its sockets to the rest of the fleet.
      if (url.pathname === '/healthz') return json(healthzPayload());
      if (url.pathname === '/readyz') {
        const payload = readyzPayload();
        return ready ? json(payload) : json({ status: 503, body: payload.body });
      }
      if (url.pathname !== path) return new Response('not found', { status: 404 });
      if (!ready || !accept.tryAccept()) {
        // Load shedding with a delay attached: refusing without one just moves the herd next door.
        return new Response('retry', {
          status: 503,
          headers: { 'retry-after-ms': String(accept.retryAfterMs(options.rng ?? Math.random)) },
        });
      }
      const data: WsData = {
        socketId: uuid(),
        clientBuildId: url.searchParams.get('build') ?? options.buildId,
        actorId: null,
      };
      return server.upgrade(request, { data })
        ? undefined
        : new Response('expected websocket', { status: 426 });
    },

    websocket: {
      idleTimeout: 120,
      backpressureLimit: 1024 * 1024,
      publishToSelf: false,
      sendPings: true,

      open(ws: SyncWs): void {
        const socket = new SyncSocket({
          ws,
          id: ws.data.socketId,
          clientBuildId: ws.data.clientBuildId,
          serverBuildId: options.buildId,
          clock,
        });
        sockets.add(socket);
      },

      message(ws: SyncWs, message: string | Uint8Array): void {
        const socket = sockets.get(ws.data.socketId);
        if (!socket) return;
        void (async () => {
          try {
            await routeFrame(socket, decode(message));
          } catch (error) {
            socket.send({
              type: 'ack',
              v: PROTOCOL_VERSION,
              ref: ws.data.socketId,
              lsn: null,
              error: toWireError(error),
            });
          }
        })();
      },

      close(ws: SyncWs): void {
        const socket = sockets.get(ws.data.socketId);
        if (!socket) return;
        options.registry.unsubscribeSocket(socket.id);
        for (const name of [...socket.topics] as Topic[]) options.hub.unsubscribe(socket, name);
        sockets.remove(socket.id);
      },
    },

    async drain(drainOptions = {}): Promise<readonly { socketId: string; afterMs: number }[]> {
      ready = false;
      const ids = [...sockets.all()].map((socket) => socket.id);
      const plan = drainPlan(ids, {
        spreadMs: options.drainSpreadMs ?? 30_000,
        ...(options.rng ? { rng: options.rng } : {}),
      });
      for (const entry of plan) {
        sockets.get(entry.socketId)?.send(reconnectFrame(entry.afterMs, 'drain'));
      }
      const graceMs = drainOptions.graceMs ?? 5_000;
      if (graceMs > 0) await new Promise((resolve) => setTimeout(resolve, graceMs));
      for (const socket of [...sockets.all()]) {
        socket.close(CLOSE.goingAway, 'drain');
        sockets.remove(socket.id);
      }
      await options.hub.close();
      return plan;
    },
  };
}

export interface ListenOptions {
  readonly port?: number;
}

/**
 * Binds the node to `Bun.serve` and wires SIGTERM to `drain()`. Kept tiny so the node itself stays
 * testable without a server.
 */
export function listenSyncNode(node: SyncNode, options: ListenOptions = {}): { stop(): void } {
  const server = Bun.serve({
    port: options.port ?? 3001,
    fetch: node.fetch,
    websocket: node.websocket,
  });
  // Same rule as @ultimat3/http: every socket the framework opens announces itself, so a request
  // back to it is recognisably this process calling itself rather than egress.
  const stopListening = markListening(server.url.origin);
  onShutdown('realtime:sync', async () => {
    await node.drain();
    await node.stop();
    server.stop();
    stopListening();
  });
  return {
    stop: () => {
      server.stop();
      stopListening();
    },
  };
}

function json(payload: { status: number; body: unknown }): Response {
  return new Response(JSON.stringify(payload.body), {
    status: payload.status,
    headers: { 'content-type': 'application/json' },
  });
}
