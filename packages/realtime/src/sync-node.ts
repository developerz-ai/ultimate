// The `sync` role. Accepts WS connections, routes frames, drains gracefully.
//
// Stateless by construction: the only per-node memory is the socket table. No sticky sessions — a
// client may reconnect to any node and resume from its cursor, which is why drain is allowed to
// redistribute connections at all.

import { type Clock, logger, markReady, reportError, systemClock, uuid } from '@ultimat3/core';
import type { ChannelHub, Topic } from './channel';
import { isClientFault } from './errors';
import type { Transport, TransportSubscription } from './fanout';
import type { LiveQueryRegistry } from './live-query';
import type { PresenceRegistry } from './presence';
import { CHANGE_SUBJECT_PREFIX, parseEnvelope, SeqGapDetector } from './replicator';
import {
  CLOSE,
  DEFAULT_MAX_BUFFERED_BYTES,
  idleSweepPeriodMs,
  SocketRegistry,
  SyncSocket,
  type WsLike,
} from './socket';
import { GrantBook, type SyncAuthenticator, sweepGrants } from './sync-auth';
import { ackRefOf, createFrameRouter, type MutationHandler } from './sync-frames';
import { decode, type Frame, PROTOCOL_VERSION, toWireError } from './sync-protocol';
import { handleUpgrade, type UpgradeTarget, type WsData } from './sync-upgrade';
import { AcceptBudget, drainPlan, type Rng, reconnectFrame } from './thundering-herd';

/** Declared with the upgrade that builds it — this file only ever reads one. */
export type { UpgradeTarget, WsData } from './sync-upgrade';

export type SyncWs = WsLike & { readonly data: WsData };

/**
 * How often an expired grant is re-decided. A third of the shortest TTL worth issuing: a grant is
 * re-checked on the pass after it expires, so the window a revoked actor keeps its socket is this
 * interval and not its token's lifetime.
 */
export const DEFAULT_REAUTH_INTERVAL_MS = 30_000;

/**
 * Concurrent sockets one node will hold. The accept budget bounds the accept RATE and nothing
 * bounded the COUNT: at the 500/s that budget permits, an attacker holding each socket open with
 * one keepalive frame a minute reaches 1.8M sockets an hour, each carrying a `GrantBook` entry.
 *
 * The number clears the 50,000 real clients this repo has measured on one node
 * (`scripts/bench/restart-bench.ts`) with room to spare, because a ceiling that refuses a proven
 * workload is an outage the framework caused.
 */
export const DEFAULT_MAX_CONNECTIONS = 250_000;

/**
 * Inbound bytes one frame may carry. Bun's own default is 16 MiB, which one authenticated socket
 * can push continuously; a `subscribe` frame carrying a full 512-id cursor is under 32 KiB.
 */
export const DEFAULT_MAX_FRAME_BYTES = 256 * 1024;

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
  readonly onMutate?: MutationHandler;
  /**
   * Who is dialling. Injected for the same reason `onMutate` is: `sync` owns no business logic and
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
    close(ws: SyncWs): void;
  };
  /** Sends every client a distinct reconnect delay, then closes. Returns the plan for tests/logs. */
  drain(options?: { graceMs?: number }): Promise<readonly { socketId: string; afterMs: number }[]>;
}

export function createSyncNode(options: SyncNodeOptions): SyncNode {
  const sockets =
    options.sockets ??
    new SocketRegistry({
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
  const clock = options.clock ?? systemClock;
  const accept = options.accept ?? new AcceptBudget({ perSecond: 500, burst: 2000, clock });
  const maxConnections = options.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const path = options.path ?? '/_x/sync';
  const presence = options.presence;
  const grants = new GrantBook();
  const gaps = new SeqGapDetector();
  let ready = false;
  let changes: TransportSubscription | null = null;
  let sweeping: ReturnType<typeof setInterval> | null = null;
  let reauthing: ReturnType<typeof setInterval> | null = null;
  let idling: ReturnType<typeof setInterval> | null = null;

  /**
   * Work nobody is waiting on — a presence leave from a synchronous close, a sweep on a timer, a
   * fanout off the change bus. It reaches the bus or a policy, so it can fail; failing must not take
   * a socket or the process with it, and must not be silent either, or "the room still shows someone
   * who left" and "that change reached nobody" have nothing to read. `operation` stays low
   * cardinality so the monitor can group on it; the topic or entity goes in `at`.
   */
  const detach = (work: Promise<unknown>, operation: string, at?: string): void => {
    void work.catch((error: unknown) => {
      logger.error(`${operation} failed`, {
        ...(at === undefined ? {} : { at }),
        error: error instanceof Error ? error.message : String(error),
      });
      // Nobody is awaiting this, so the log is the only trace it leaves — and a log is not a
      // signal anyone is paged on. The bus is this node's dependency, never the client's.
      reportError(error, { source: 'realtime', scope: { operation } });
    });
  };

  /**
   * Everything `start()` acquired that is not a socket: the change subscription and the presence
   * sweep. Both `drain()` and `stop()` run it, because a `drain()` is terminal on its own — it
   * closes the hub — and `listenSyncNode` is the only caller that follows one with the other. A
   * node that drained and kept its subscription goes on pulling changes off the bus and sweeping
   * presence for a fleet it has already left, with no socket to deliver either to. Idempotent:
   * running it twice is the normal case.
   */
  const release = (): void => {
    changes?.unsubscribe();
    changes = null;
    if (sweeping !== null) clearInterval(sweeping);
    sweeping = null;
    if (reauthing !== null) clearInterval(reauthing);
    reauthing = null;
    if (idling !== null) clearInterval(idling);
    idling = null;
    gaps.forget();
  };

  /**
   * Everything one socket held, released once. Bun's `close` callback runs it, and so does a
   * revoked grant — a socket this node closes itself gets no callback in a unit test, and in
   * production the second run is the no-op every step here already is.
   */
  const teardown = (socket: SyncSocket): void => {
    options.registry.unsubscribeSocket(socket.id);
    const topics = [...socket.topics] as Topic[];
    for (const name of topics) options.hub.unsubscribe(socket, name);
    sockets.remove(socket.id);
    grants.delete(socket.id);
    // A closed socket is a leave, said now rather than left to TTL: everyone else would otherwise
    // keep rendering a member who is provably gone for the rest of its window. The write is on the
    // bus and the close callback is synchronous, so it cannot be awaited here.
    if (presence) {
      for (const name of topics) detach(presence.leave(name, socket.id), 'presence.leave', name);
    }
  };

  /**
   * The node's one eviction: close, then release everything the socket held. Every path that ends
   * a socket without a `close` callback behind it — the drain, the idle sweep — goes through it,
   * because dropping the socket from the table is three of `teardown`'s five steps and the two it
   * misses are the ones another node can see.
   */
  const evict = (socket: SyncSocket, code: number, reason: string): void => {
    socket.close(code, reason);
    teardown(socket);
  };

  /**
   * One pass over the grants whose window has closed. This is the half R2 was missing: `reauthorize`
   * and `onActorChange` were both written and neither had a caller, so a socket that was accepted
   * was authorized for as long as it stayed open — and an active client's socket never idles out,
   * because every inbound frame touches it.
   */
  const reauthenticate = async (): Promise<void> => {
    await sweepGrants({
      grants,
      clock,
      onActor: async (socketId, actor) => {
        const socket = sockets.get(socketId);
        if (!socket) return;
        // The hub sets `socket.actor` and drops the topics this actor may no longer read; the
        // registry re-decides every live subscription and desyncs the survivors, so the next
        // delivery re-snapshots them under the new authority rather than the old window.
        await options.hub.onActorChange(socket, actor);
        await options.registry.reauthorize(socket);
      },
      onRevoked: (socketId) => {
        const socket = sockets.get(socketId);
        if (!socket) return;
        teardown(socket);
        socket.close(CLOSE.policy, 'grant expired');
      },
      onRefreshFailed: (socketId, error) => {
        // Not a denial: the grant is kept and retried next pass. Reported because a socket nobody
        // can re-decide is not something to discover from a connection graph.
        reportError(error, {
          source: 'realtime',
          scope: { operation: 'sync.reauthenticate', extra: { socketId } },
        });
      },
    });
  };

  const routeFrame = createFrameRouter({
    hub: options.hub,
    registry: options.registry,
    buildId: options.buildId,
    presence,
    onMutate: options.onMutate,
  });

  return {
    sockets,

    get ready(): boolean {
      return ready;
    },

    async start(): Promise<void> {
      changes = await options.transport.subscribe(`${CHANGE_SUBJECT_PREFIX}.>`, (payload) => {
        const envelope = parseEnvelope(payload);
        if (!envelope) return;
        // Fanout is at-most-once over core NATS, so a reconnect is changes this node never saw.
        // Nothing downstream could notice: no window's lsn moved, so no cursor moved, so nothing
        // ever asked for a re-snapshot. A gap invalidates every window here instead, and the
        // subscribers are re-served on the next change to each query.
        if (gaps.observe(envelope)) {
          const marked = options.registry.invalidate();
          logger.warn('live.change_gap', { entity: envelope.change.entity, desynced: marked });
        }
        // Not awaited: the bus handler must return before the next change, and ordering is the
        // registry's — one serial lane per query id. What this call site owes is the failure. An
        // unhandled rejection here is a fanout that reached nobody, reported as a dead process.
        detach(options.registry.deliver(envelope.change), 'live.deliver', envelope.change.entity);
      });
      // One pass per heartbeat window: a member is swept only once it has actually missed its
      // window, and the interval never holds the process open — shutdown is the drain's job.
      if (presence) {
        sweeping = setInterval(
          () => detach(presence.sweepAll(), 'presence.sweep'),
          presence.heartbeatMs,
        );
        sweeping.unref();
      }
      // The half-open connection Bun's own `idleTimeout` renews through its ping/pong: a client
      // whose frame loop is wedged answers pings and keeps its grant, its subscriptions and its
      // topic membership. `sweepIdle` was written for this and never called, so `touch()` and the
      // 120s budget under it decided nothing.
      idling = setInterval(() => {
        for (const socket of sockets.idle()) evict(socket, CLOSE.idle, 'idle timeout');
      }, idleSweepPeriodMs(sockets.idleTimeoutMs));
      idling.unref();
      if (options.authenticate) {
        reauthing = setInterval(
          () => detach(reauthenticate(), 'sync.reauthenticate'),
          options.reauthenticateIntervalMs ?? DEFAULT_REAUTH_INTERVAL_MS,
        );
        reauthing.unref();
      } else {
        // Enforced where it can be: nothing here can invent a credential, so the one honest signal
        // is that every policy on this node is about to be asked about `null`.
        logger.warn('sync node has no authenticator: every socket is anonymous', {
          buildId: options.buildId,
          fix: 'pass authenticate to createSyncNode({ authenticate })',
        });
      }
      ready = true;
      markReady();
      logger.info('sync node ready', { buildId: options.buildId, path });
    },

    stopAccepting(): void {
      ready = false;
    },

    async stop(): Promise<void> {
      ready = false;
      release();
    },

    async fetch(request: Request, server: UpgradeTarget): Promise<Response | undefined> {
      return await handleUpgrade(
        {
          path,
          buildId: options.buildId,
          maxConnections,
          accept,
          rng: options.rng ?? Math.random,
          // Read per call, never captured: `ready` and the socket count both move while a request
          // is parked inside `authenticate`, which is the whole reason they are functions.
          ready: () => ready,
          socketCount: () => sockets.count,
          newSocketId: () => uuid(),
          authenticate: options.authenticate,
          onGranted: (socketId, grant) => grants.set(socketId, grant),
        },
        request,
        server,
      );
    },

    websocket: {
      idleTimeout: 120,
      // The same number `SyncSocket` refuses to add past, never a second spelling of it. Bun's
      // limit set lower and our own check never fires: the runtime drops the frame with nothing
      // marked desynced, which is the silent divergence the mark exists to prevent.
      backpressureLimit: DEFAULT_MAX_BUFFERED_BYTES,
      // No `publishToSelf`: this node never publishes to a native topic. Every channel frame is
      // one filtered `send` per socket through `SocketRegistry.deliver`, which is the only path
      // that can count the frame it dropped — a flag configuring a mechanism nothing uses reads
      // as a live one to the next person who has to decide how delivery works.
      maxPayloadLength: options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      sendPings: true,

      open(ws: SyncWs): void {
        // The actor the upgrade resolved, carried into the socket the whole pipeline decides
        // against — the topic guard, `authorize`, `visible`, the per-tenant cap. It was hardcoded
        // `null` here, which made every one of those a decision about nobody.
        const socket = new SyncSocket({
          ws,
          id: ws.data.socketId,
          clientBuildId: ws.data.clientBuildId,
          serverBuildId: options.buildId,
          actor: grants.get(ws.data.socketId)?.actor ?? null,
          clock,
          ...(options.maxFramesPerSecond === undefined
            ? {}
            : { maxFramesPerSecond: options.maxFramesPerSecond }),
          ...(options.frameBurst === undefined ? {} : { frameBurst: options.frameBurst }),
          ...(options.maxBufferedBytes === undefined
            ? {}
            : { maxBufferedBytes: options.maxBufferedBytes }),
          ...(options.maxDroppedFrames === undefined
            ? {}
            : { maxDroppedFrames: options.maxDroppedFrames }),
        });
        sockets.add(socket);
      },

      message(ws: SyncWs, message: string | Uint8Array): void {
        const socket = sockets.get(ws.data.socketId);
        if (!socket) return;
        void (async () => {
          // Decoded into a binding the failure path can read: an ack has to name the thing that
          // failed — the mutation key the client's queue holds, the sid its subscription holds —
          // and a frame that could not be decoded is the one case where there is nothing to name.
          let frame: Frame | null = null;
          try {
            frame = decode(message);
            await routeFrame(socket, frame);
          } catch (error) {
            // The ack frame tells the client what it did wrong; the monitor only hears about what
            // this node did wrong. Same rule the HTTP pipeline applies at `status >= 500`.
            if (!isClientFault(error)) {
              reportError(error, {
                source: 'realtime',
                scope: { operation: 'sync.frame', extra: { socketId: socket.id } },
              });
            }
            socket.send({
              type: 'ack',
              v: PROTOCOL_VERSION,
              ref: ackRefOf(frame, ws.data.socketId),
              lsn: null,
              error: toWireError(error),
            });
          }
        })();
      },

      close(ws: SyncWs): void {
        const socket = sockets.get(ws.data.socketId);
        if (!socket) {
          // The socket is already gone, but a grant recorded for an upgrade whose `open` never ran
          // is not — and nothing else would ever reach it.
          grants.delete(ws.data.socketId);
          return;
        }
        teardown(socket);
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
      // Through `evict`, never `sockets.remove` + `grants.delete`: those are three of `teardown`'s
      // five steps, and the two they skip are the ones the rest of the fleet can see. A drained
      // socket that never left its presence set is a member every other node renders for a full
      // TTL — during a rolling restart, beside the same client's reconnection under a new id —
      // and its live subscriptions stay in the registry, so `entry.subscribers` never empties and
      // the matcher, the shared window and the retained ring are pinned for the process's life.
      for (const socket of [...sockets.all()]) evict(socket, CLOSE.goingAway, 'drain');
      // Released once the sockets are gone rather than at the top: a client is entitled to its
      // patches for the whole grace window, and it is entitled to them *before* the hub the
      // fanout writes through is closed.
      release();
      await options.hub.close();
      return plan;
    },
  };
}

/**
 * An upgrade refused before a socket exists, rendered as the error contract rather than as a word.
 * There is no frame to carry it — the client never got a connection — so the body is the only
 * channel, and `--json` on every error means this one too.
 */
