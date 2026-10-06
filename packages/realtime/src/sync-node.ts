// The `sync` role. Accepts WS connections, routes frames, drains gracefully.
//
// Stateless by construction: the only per-node memory is the socket table. No sticky sessions — a
// client may reconnect to any node and resume from its cursor, which is why drain is allowed to
// redistribute connections at all.

import {
  DEFAULT_HEALTH_DETAIL_PEERS,
  logger,
  markReady,
  reportError,
  systemClock,
  uuid,
} from '@ultimat3/core';
import type { Topic } from './channel';
import { ChannelSids } from './channel-sids';
import { detach } from './detach';
import { evictInChunks } from './drain-evictions';
import { isClientFault } from './errors';
import type { TransportSubscription } from './fanout';
import { PrincipalSockets } from './principal-sockets';
import { CHANGE_SUBJECT_ALL } from './replicator';
import { SeqGapDetector } from './replicator-envelope';
import { CLOSE, SocketRegistry, SyncSocket } from './socket';
import { DEFAULT_MAX_BUFFERED_BYTES } from './socket-defaults';
import { idleSweepPeriodMs } from './socket-idle';
import { actorChangeHandler } from './sync-actor-change';
import { GrantBook, sweepGrants } from './sync-auth';
import { changeHandler, reconnectHandler } from './sync-bus-handlers';
import { ackRefOf, createFrameRouter } from './sync-frames';
import {
  clientHeartbeatMs,
  drainGraceMs,
  socketCeilings,
  syncNodeBounds,
} from './sync-node-bounds';
import type { SyncNode, SyncNodeOptions, SyncWs } from './sync-node-contract';
import { decode, type Frame, PROTOCOL_VERSION, toWireError } from './sync-protocol';
import { handleUpgrade, type UpgradeTarget } from './sync-upgrade';
import { AcceptBudget, type DrainedSocket, drainPlan, reconnectFrame } from './thundering-herd';

// Moved to `sync-node-bounds.ts` with the refusals that read them, and re-exported here because
// `server.ts` publishes all three and a moved constant must not become a moved import path.
export {
  DEFAULT_MAX_CONNECTIONS,
  DEFAULT_MAX_FRAME_BYTES,
  DEFAULT_REAUTH_INTERVAL_MS,
} from './sync-node-bounds';

/** The node's shapes — options, the node itself, its socket — live beside it, in their own file. */
export type { SyncNode, SyncNodeOptions, SyncWs } from './sync-node-contract';
/** Declared with the upgrade that builds it — this file only ever reads one. */
export type { UpgradeTarget, WsData } from './sync-upgrade';

export function createSyncNode(options: SyncNodeOptions): SyncNode {
  const sockets =
    options.sockets ??
    new SocketRegistry({
      ...(options.clock ? { clock: options.clock } : {}),
      ...(options.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.idleTimeoutMs }),
    });
  const clock = options.clock ?? systemClock;
  const accept = options.accept ?? new AcceptBudget({ perSecond: 500, burst: 2000, clock });
  const bounds = syncNodeBounds(options);
  // Screened at construction, once, and reused per socket: the four ceilings below are read inside
  // `websocket.open`, which Bun runs synchronously inside `server.upgrade`, so refusing them there
  // is a node that boots clean and throws out of every upgrade. `sync-node-bounds.ts` carries why.
  const ceilings = socketCeilings(options);
  const path = options.path ?? '/_x/sync';
  const presence = options.presence;
  const grants = new GrantBook();
  const principals = new PrincipalSockets(options.maxSocketsPerActor);
  const gaps = new SeqGapDetector();
  const channelSids = new ChannelSids();
  let reconnects: (() => void) | null = null;
  /** The re-auth pass in flight, shared by every tick that lands while it runs. */
  let reauthPass: Promise<void> | null = null;
  let ready = false;
  /**
   * The start in flight or done, and whether a stop/drain has run since. `start()` awaits the bus,
   * and a stop inside that await found nothing to release: the subscription landed after it and
   * the node came up `ready` and delivering after it was stopped. The `replicator.ts` pattern.
   */
  let started: Promise<void> | null = null;
  let generation = 0;
  /** Resolved by `teardown` when the last socket leaves, for a drain that is waiting its grace. */
  let lastSocketLeft: (() => void) | null = null;
  let changes: TransportSubscription | null = null;
  let sweeping: ReturnType<typeof setInterval> | null = null;
  let reauthing: ReturnType<typeof setInterval> | null = null;
  let idling: ReturnType<typeof setInterval> | null = null;

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
    reconnects?.();
    reconnects = null;
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
   *
   * Returns the presence leaves it started, which is the only step here that is not over when this
   * function returns: `close` is a SYNCHRONOUS Bun callback and cannot await one, so the promise is
   * both detached (that path has nobody to wait for it) and handed back (the drain does).
   */
  const teardown = (socket: SyncSocket): readonly Promise<unknown>[] => {
    options.registry.unsubscribeSocket(socket.id);
    // Suspended seats included, and the presence rooms read BEFORE the seats are given back: the
    // hub forgets a topic's declaration with its last member.
    const topics = options.hub.topicsOf(socket);
    const rooms = topics.filter(hasRoster);
    for (const name of topics) options.hub.unsubscribe(socket, name);
    sockets.remove(socket.id);
    grants.delete(socket.id);
    principals.release(socket.id);
    if (sockets.count === 0) lastSocketLeft?.();
    // A closed socket is a leave, said now rather than left to TTL: everyone else would otherwise
    // keep rendering a member who is provably gone for the rest of its window. The write is on the
    // bus and the close callback is synchronous, so it cannot be awaited here.
    const leaves: Promise<unknown>[] = [];
    if (presence) {
      // Only a channel declared `events: true` has a roster: a leave on any other was a KV read,
      // a KV write and a presence event on a channel that never carried one.
      for (const name of rooms) {
        const leave = presence.leave(name, socket.id);
        // Detached as well as returned: `detach` attaches the reporting catch, so a caller that
        // awaits this later is awaiting a promise whose rejection is already handled.
        detach(leave, 'presence.leave', name);
        leaves.push(leave);
      }
    }
    return leaves;
  };

  /**
   * The node's one eviction: close, then release everything the socket held. Every path that ends
   * a socket without a `close` callback behind it — the drain, the idle sweep — goes through it,
   * because dropping the socket from the table is three of `teardown`'s five steps and the two it
   * misses are the ones another node can see.
   */
  /** `graceMs`, or until `teardown` reports the table empty — whichever comes first. */
  const graceOrEmpty = (graceMs: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(done, graceMs);
      function done(): void {
        clearTimeout(timer);
        lastSocketLeft = null;
        resolve();
      }
      lastSocketLeft = done;
    });

  /** Whether this topic's channel carries presence — asked while the hub still knows the topic. */
  function hasRoster(name: Topic): boolean {
    return options.hub.channelOf(name)?.channel.events === true;
  }

  const evict = (socket: SyncSocket, code: number, reason: string): readonly Promise<unknown>[] => {
    socket.close(code, reason);
    return teardown(socket);
  };

  /**
   * One pass over the grants whose window has closed. This is the half R2 was missing: `reauthorize`
   * and `onActorChange` were both written and neither had a caller, so a socket that was accepted
   * was authorized for as long as it stayed open — and an active client's socket never idles out,
   * because every inbound frame touches it.
   */
  const reauthenticate = (): Promise<void> => {
    // One pass at a time. The interval does not wait for the pass it started: after a deploy every
    // grant expires in one window, a pass over them can outlast the interval, and each overlapping
    // tick then refreshed the same grants again and re-snapshotted the same subscriptions.
    reauthPass ??= reauthPassOnce().finally(() => {
      reauthPass = null;
    });
    return reauthPass;
  };

  const onActor = actorChangeHandler({
    sockets,
    hub: options.hub,
    registry: options.registry,
    channelSids,
    presence,
  });

  const reauthPassOnce = async (): Promise<void> => {
    await sweepGrants({
      grants,
      clock,
      refreshDeadlineMs: options.grantRefreshDeadlineMs,
      onActor,
      onRevoked: (socketId) => {
        const socket = sockets.get(socketId);
        if (!socket) return;
        // Through `evict`, which closes BEFORE it releases. The other order was a close that never
        // happened: `teardown` reaches `sockets.remove`, which closes the socket itself with
        // `1001 connection closed`, and `SyncSocket.close` returns once `#closed` — so a revoked
        // grant reached the client as a normal shutdown, which it retries against this node with
        // the same dead credential, instead of the `1008` that tells it to re-dial with a new one.
        evict(socket, CLOSE.policy, 'grant expired');
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
    channelSids,
    heartbeatMs: clientHeartbeatMs(presence?.heartbeatMs, sockets.idleTimeoutMs),
  });

  /** Everything `start()` does, fenced on the generation it began under — see `started`. */
  const begin = async (): Promise<void> => {
    const run = generation;
    const bus = { registry: options.registry, hub: options.hub, gaps };
    const subscription = await options.transport.subscribe(CHANGE_SUBJECT_ALL, changeHandler(bus));
    // A stop or drain ran inside that await: what it released did not include this yet.
    if (run !== generation) {
      subscription.unsubscribe();
      return;
    }
    changes = subscription;
    reconnects = options.transport.onReconnect(reconnectHandler(bus));
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
        bounds.reauthenticateIntervalMs,
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
  };

  /** Ends the current generation and waits out a start in flight, so nothing it took outlives us. */
  const halt = async (): Promise<void> => {
    generation += 1;
    ready = false;
    const inFlight = started;
    started = null;
    if (inFlight !== null) await inFlight.catch(() => undefined);
  };

  return {
    sockets,
    path,
    principalSockets: (principal) => principals.count(principal),

    get ready(): boolean {
      return ready;
    },

    start(): Promise<void> {
      // Memoised: two overlapping starts were two subscriptions, every change fanned out twice.
      if (started !== null) return started;
      // Cleared only if it is still THIS attempt's memo: an older start failing after a stop and
      // a newer start must not wipe the newer one, or a third start subscribes a second time.
      const attempt: Promise<void> = begin().catch((error: unknown) => {
        if (started === attempt) started = null;
        throw error;
      });
      started = attempt;
      return attempt;
    },

    stopAccepting(): void {
      ready = false;
    },

    async stop(): Promise<void> {
      // `halt()` ends the generation synchronously, before its first await; what the current
      // start installed is released right then. An older start still in flight is fenced by its
      // generation and drops what it subscribes late itself, and a start() issued after this line
      // owns a fresh bus that the wait below must not touch.
      const waiting = halt();
      release();
      await waiting;
    },

    async fetch(request: Request, server: UpgradeTarget): Promise<Response | undefined> {
      return await handleUpgrade(
        {
          path,
          buildId: options.buildId,
          maxConnections: bounds.maxConnections,
          accept,
          rng: options.rng ?? Math.random,
          // Read per call, never captured: `ready` and the socket count both move while a request
          // is parked inside `authenticate`, which is the whole reason they are functions.
          ready: () => ready,
          socketCount: () => sockets.count,
          newSocketId: () => uuid(),
          authenticate: options.authenticate,
          allowedOrigins: options.allowedOrigins,
          admitReachedOrigin: options.admitReachedOrigin,
          clientAddressOf: options.clientAddressOf,
          healthDetailPeers: options.healthDetailPeers ?? DEFAULT_HEALTH_DETAIL_PEERS,
          onGranted: (socketId, grant) => grants.set(socketId, grant),
          // The other half of recording the grant before the upgrade: an upgrade that never took
          // gets no `close` callback, so this is the only thing that can free its entry.
          onUngranted: (socketId) => {
            grants.delete(socketId);
            principals.release(socketId);
          },
          principals,
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
      maxPayloadLength: bounds.maxFrameBytes,
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
          clientAddress: ws.data.clientAddress ?? null,
          clock,
          ...ceilings,
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

      drain(ws: SyncWs): void {
        // A `records` frame backpressure refused left this socket gapped on that channel; the
        // repair is the node's verdict, sent the moment the socket can take a frame again.
        const socket = sockets.get(ws.data.socketId);
        if (socket) sockets.gapRepairs.repairAll(socket);
      },

      close(ws: SyncWs): void {
        const socket = sockets.get(ws.data.socketId);
        if (!socket) {
          // The socket is already gone, but a grant recorded for an upgrade whose `open` never ran
          // is not — and nothing else would ever reach it.
          grants.delete(ws.data.socketId);
          principals.release(ws.data.socketId);
          return;
        }
        teardown(socket);
      },
    },

    async drain(drainOptions = {}): Promise<readonly DrainedSocket[]> {
      await halt();
      const ids = [...sockets.all()].map((socket) => socket.id);
      const spread = drainPlan(ids, {
        spreadMs: bounds.drainSpreadMs,
        ...(options.rng ? { rng: options.rng } : {}),
      });
      // The answer is read, not assumed: this frame IS the socket's slot, so a client that never
      // received one reconnects on its own backoff — the herd the spread exists to break, minus
      // that client. Nothing repairs it, so what the drop owes is a count.
      const plan: DrainedSocket[] = spread.map((entry) => ({
        ...entry,
        notified:
          sockets.get(entry.socketId)?.send(reconnectFrame(entry.afterMs, 'drain')) === true,
      }));
      const notified = plan.reduce((total, entry) => total + (entry.notified ? 1 : 0), 0);
      if (notified < plan.length) {
        logger.warn('sync.drain_frames_dropped', { sockets: plan.length, notified });
      }
      // The grace is what a socket is OWED after its reconnect frame — its patches, until its own
      // delay is up — so it is waited only while there is a socket to owe it to, and ends the
      // moment the last one leaves. Unconditional, it was 5.0s of a 5.1s Ctrl-C on `x dev` with
      // no browser open (measured 2026-09-06): a drain of zero sockets, sleeping for nobody.
      const graceMs = drainGraceMs(drainOptions.graceMs);
      if (graceMs > 0 && sockets.count > 0) await graceOrEmpty(graceMs);
      // Through `evict`, never `sockets.remove` + `grants.delete`: those are three of `teardown`'s
      // five steps, and the two they skip are the ones the rest of the fleet can see. A drained
      // socket that never left its presence set is a member every other node renders for a full
      // TTL — during a rolling restart, beside the same client's reconnection under a new id —
      // and its live subscriptions stay in the registry, so `entry.subscribers` never empties.
      //
      // AWAITED, in chunks: a leave is a write to the shared set, so a drain that merely started
      // them released, closed the hub and let the process exit with N·M writes still on the wire —
      // which is that same full-TTL double vision, reached the long way round.
      await evictInChunks([...sockets.all()], (socket) => evict(socket, CLOSE.goingAway, 'drain'));
      // Released once the sockets are gone rather than at the top: a client is entitled to its
      // patches for the whole grace window, and it is entitled to them *before* the hub the
      // fanout writes through is closed.
      release();
      await options.hub.close();
      return plan;
    },
  };
}
