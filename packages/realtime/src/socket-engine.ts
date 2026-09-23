// The socket engine (plan 101, slice 11): ONE sync socket shared by every tab of an origin and
// principal, talking to each tab only over a `MessagePort`. Host-agnostic — the SharedWorker entry
// and the in-page fallback run this same code. Each tab keeps its own `LiveClient` and store; to
// it, its port IS a socket. This file is the socket's lifecycle — dial, beat, redial, reap; the
// multiplexing (one membership per topic, frames routed per port) is `socket-routes.ts`.

import { type Clock, finiteOption, systemClock } from '@ultimat3/core/page';
import type { ClientSocket } from './client-contract';
import { DEFAULT_HEARTBEAT_MS, Heartbeat } from './client-heartbeat';
import type { SyncTarget } from './page-store';
import type { AttachedPort, PortLike, PortMessage } from './socket-port';
import { PortRouter } from './socket-routes';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';
import {
  type BackoffPolicy,
  browserBackoff,
  policyDelay,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';

// The port seam is its own module; these are the names every host already imports from here.
export { messagePort, type PortLike, type PortMessage } from './socket-port';

export interface SocketEngineOptions {
  /** Dials the real socket. Production: `browserSocket(dialUrl(target))`. */
  readonly dial: (target: SyncTarget) => ClientSocket;
  readonly scheduler?: Scheduler;
  readonly clock?: Clock;
  readonly backoff?: BackoffPolicy;
  readonly rng?: Rng;
  /** The engine's own beat on the real socket, and the unit a silent port is reaped in. */
  readonly heartbeatMs?: number;
}

/** A tab beats every heartbeat; three missed beats and its port is reaped — a tab has no close. */
export const REAP_AFTER_BEATS = 3;

export class SocketEngine {
  readonly #options: SocketEngineOptions;
  readonly #clock: Clock;
  readonly #schedule: Scheduler;
  readonly #beatMs: number;
  readonly #ports = new Map<number, AttachedPort>();
  readonly #router: PortRouter;
  readonly #heartbeat: Heartbeat;
  #next = 1;
  #target: SyncTarget | null = null;
  #socket: ClientSocket | null = null;
  #up = false;
  #attempt = 0;
  #reconnect: (() => void) | null = null;
  #reaper: (() => void) | null = null;
  #hello: Frame | null = null;
  #update: string | null = null;

  constructor(options: SocketEngineOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#schedule = options.scheduler ?? timeoutScheduler;
    this.#beatMs = finiteOption(
      'SocketEngine',
      'heartbeatMs',
      options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
    );
    this.#heartbeat = new Heartbeat({
      intervalMs: this.#beatMs,
      schedule: this.#schedule,
      now: () => this.#now(),
      beat: () => this.#beat(),
      onSilence: () => this.#lost(),
    });
    this.#router = new PortRouter({
      send: (frame) => this.#send(frame),
      post: (attached, message) => this.#post(attached, message),
      port: (id) => this.#ports.get(id),
      ports: () => this.#ports.values(),
    });
  }

  /** Ports attached right now. Tests and the worker's own diagnostics read it. */
  get ports(): number {
    return this.#ports.size;
  }

  attach(port: PortLike): void {
    const attached: AttachedPort = {
      id: this.#next++,
      port,
      open: false,
      asked: false,
      lastSeen: this.#now(),
      topics: new Set(),
      lives: new Map(),
    };
    this.#ports.set(attached.id, attached);
    port.onmessage = (event) => this.#fromPort(attached, event.data);
    this.#armReaper();
  }

  #fromPort(attached: AttachedPort, message: unknown): void {
    if (!this.#ports.has(attached.id) || typeof message !== 'object' || message === null) return;
    attached.lastSeen = this.#now();
    const typed = message as PortMessage;
    if (typed.t === 'open') {
      const arriving = !attached.asked;
      attached.open = true;
      attached.asked = true;
      this.#target ??= typed.target;
      if (this.#up) {
        this.#post(attached, { t: 'open', target: typed.target });
        return;
      }
      // A page arriving is a fresh reason to believe the node is back (a reload, a deploy): the
      // wait an earlier page's failures built up is not this page's to inherit.
      if (arriving && this.#socket === null) this.#restartCurve();
      this.#dial();
      return;
    }
    if (typed.t === 'close') {
      // The tab closed its virtual socket — a redial on the same port. Its wants go; the port stays.
      this.#router.release(attached);
      attached.open = false;
      return;
    }
    if (typed.t === 'bye') {
      this.#detach(attached);
      return;
    }
    if (typed.t === 'frame' && this.#up) this.#fromTab(attached, typed.data);
  }

  #fromTab(attached: AttachedPort, data: string): void {
    let frame: Frame;
    try {
      frame = decode(data);
    } catch {
      return;
    }
    if (frame.type === 'hello') {
      // The tab's beat is this engine's ping: answer it, and add the one thing a beat learns.
      this.#post(attached, { t: 'frame', data: encode(this.#helloReply()) });
      if (this.#update !== null) {
        const update: Frame = {
          type: 'update-available',
          v: PROTOCOL_VERSION,
          buildId: this.#update,
        };
        this.#post(attached, { t: 'frame', data: encode(update) });
      }
      return;
    }
    if (frame.type === 'subscribe') this.#router.subscribe(attached, frame);
  }

  /** Release the port itself: a tab that said `bye`, or one silent for three beats. */
  #detach(attached: AttachedPort): void {
    if (!this.#ports.delete(attached.id)) return;
    this.#router.release(attached);
    attached.port.onmessage = null;
    attached.port.close?.();
    if (this.#ports.size === 0) this.#shutdown();
  }

  #fromServer(data: string): void {
    let frame: Frame;
    try {
      frame = decode(data);
    } catch {
      return;
    }
    switch (frame.type) {
      case 'hello':
        this.#hello = frame;
        return;
      case 'snapshot':
      case 'patch':
      case 'ack':
      case 'records':
      case 'replay-gap':
      case 'events':
        this.#router.route(frame, data);
        return;
      case 'update-available':
        this.#update = frame.buildId;
        for (const attached of this.#ports.values()) this.#post(attached, { t: 'frame', data });
        return;
      case 'reconnect':
        // The node assigned this socket its slot in a drain spread: honour it, once, for everyone.
        this.#lost(frame.afterMs);
        return;
      case 'subscribe':
        return;
    }
  }

  #dial(): void {
    if (this.#socket !== null || this.#reconnect !== null || this.#target === null) return;
    const target = this.#target;
    let socket: ClientSocket;
    try {
      socket = this.#options.dial(target);
    } catch {
      this.#scheduleReconnect(null);
      return;
    }
    this.#socket = socket;
    socket.onOpen(() => {
      if (this.#socket !== socket) return;
      this.#up = true;
      this.#attempt = 0;
      socket.send(encode(this.#ownHello()));
      this.#heartbeat.start(this.#now());
      for (const attached of this.#ports.values()) {
        if (attached.open) this.#post(attached, { t: 'open', target });
      }
    });
    socket.onMessage((data) => {
      if (this.#socket !== socket) return;
      this.#heartbeat.saw(this.#now());
      this.#fromServer(data);
    });
    socket.onClose(() => {
      if (this.#socket !== socket) return;
      this.#lost();
    });
  }

  /**
   * The real socket is gone. Every tab's virtual socket closes with it, and each tab's own client
   * re-opens and resubscribes FROM ITS CURSORS — the engine keeps no subscription state across a
   * reconnect, so there is nothing here to go stale.
   */
  #lost(afterMs: number | null = null): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#up = false;
    this.#heartbeat.stop();
    socket?.close(1000, 'engine reconnect');
    this.#router.clear();
    for (const attached of this.#ports.values()) {
      if (attached.open) this.#post(attached, { t: 'close', code: 1006 });
      attached.open = false;
    }
    if (this.#ports.size > 0) this.#scheduleReconnect(afterMs);
  }

  #scheduleReconnect(afterMs: number | null): void {
    if (this.#reconnect !== null) return;
    const rng = this.#options.rng ?? Math.random;
    const delay =
      // `#attempt` counts reconnects already scheduled, from 0; the wait being armed is the next one.
      afterMs ?? policyDelay(this.#options.backoff ?? browserBackoff, this.#attempt + 1, rng);
    this.#attempt += 1;
    this.#reconnect = this.#schedule(() => {
      this.#reconnect = null;
      // Dialled only for a tab that is asking: a tab re-asks through its own client's timer.
      if ([...this.#ports.values()].some((attached) => attached.open)) this.#dial();
    }, delay);
  }

  #restartCurve(): void {
    this.#reconnect?.();
    this.#reconnect = null;
    this.#attempt = 0;
  }

  /**
   * No page left. A SharedWorker can outlive its last page for a moment and be handed the next
   * one, so NOTHING a page brought survives here: not the curve, and not the target — a page of
   * the next build would otherwise dial with the old build id and be told to update forever.
   */
  #shutdown(): void {
    this.#restartCurve();
    this.#target = null;
    this.#hello = null;
    this.#update = null;
    this.#reaper?.();
    this.#reaper = null;
    const socket = this.#socket;
    this.#socket = null;
    this.#up = false;
    this.#heartbeat.stop();
    socket?.close(1000, 'no tab left');
  }

  /**
   * A silent port, released — and TOLD first. Silent is usually a closed tab, but a hidden tab the
   * browser throttled is silent too, and it was released without a word: its virtual socket stayed
   * "open" over a port nobody read, and that tab's realtime was dead until a reload. Told, its
   * client goes offline and redials, and the page re-hosts (`socket-host.ts`'s `rehosting`).
   */
  #reap(attached: AttachedPort): void {
    if (attached.open) this.#post(attached, { t: 'close', code: 1006 });
    this.#detach(attached);
  }

  /** A `MessagePort` has no close event: a port silent for three beats is a closed tab. */
  #armReaper(): void {
    if (this.#reaper !== null) return;
    this.#reaper = this.#schedule(() => {
      this.#reaper = null;
      const cutoff = this.#now() - REAP_AFTER_BEATS * this.#beatMs;
      for (const attached of [...this.#ports.values()]) {
        if (attached.lastSeen < cutoff) this.#reap(attached);
      }
      if (this.#ports.size > 0) this.#armReaper();
    }, this.#beatMs);
  }

  #beat(): void {
    this.#send(this.#ownHello());
    this.#router.announce();
  }

  /** What this engine says to the node: the build every tab of it was rendered by. */
  #ownHello(): Frame {
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      buildId: this.#target?.buildId ?? '',
      sessionId: null,
      actorId: null,
    };
  }

  /** What a tab's beat is answered with: the node's own hello once there is one. */
  #helloReply(): Frame {
    return this.#hello ?? this.#ownHello();
  }

  #send(frame: Frame): void {
    if (this.#up) this.#socket?.send(encode(frame));
  }

  #post(attached: AttachedPort, message: PortMessage): void {
    attached.port.postMessage(message);
  }

  #now(): number {
    return this.#clock.now().getTime();
  }
}
