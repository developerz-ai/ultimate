// The client half of the sync protocol: one socket's lifecycle — dial, beat, reconnect — and the
// live windows and topics riding it. Framework-agnostic and reactive-runtime-free on purpose: ONE
// client serves the whole page (every island bundle reaches it through the page handle), and a
// signal belongs to one bundle's solid-js, so everything here is a plain read plus a listener.
// Read-only: the socket carries no writes (`useMutation` is HTTP).

import { type Clock, finiteOption, systemClock, uuid } from '@ultimat3/core/page';
import {
  ChannelBook,
  type ChannelHandlers,
  type ChannelMembership,
  type ChannelRef,
} from './client-channels';
import type { ClientSocket, LiveClientOptions, LiveHandle, LiveQueryRef } from './client-contract';
import { applyFrame, type ClientFrameTarget } from './client-frames';
import { DEFAULT_HEARTBEAT_MS, Heartbeat } from './client-heartbeat';
import type { LiveCursor } from './cursor';
import type { JsonObject, JsonValue } from './json';
import { type LiveState, type Registration, RowWindows, unnamedType } from './live-rows';
import { RecordStore } from './record-store';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';
import { backoffDelay, browserBackoff, timeoutScheduler } from './thundering-herd';

export type {
  ClientSocket,
  LiveClientOptions,
  LiveHandle,
  LiveQueryRef,
  Unsubscribe,
} from './client-contract';

/** The four states a live subscription renders. Declared with the window that holds them. */
export type { LiveState } from './live-rows';

/**
 * Private-use close code (4000–4999), so a heartbeat timeout is distinguishable in a log. A browser
 * accepts only 1000 and 3000–4999 from script; `RECONNECT_CODE` (`client-frames.ts`) is the
 * sibling, for the close a `reconnect` frame makes.
 */
const HEARTBEAT_TIMEOUT_CODE = 4000;

/** The default reporter: `console.error`, never core's `logger` — that writes `process.stderr`. */
const reportToConsole = (error: unknown): void => {
  console.error(error);
};

export class LiveClient {
  readonly #options: LiveClientOptions;
  readonly #clock: Clock;
  readonly #onError: (error: unknown) => void;
  readonly #registrations = new Map<string, Registration>();
  readonly #windows: RowWindows;
  readonly #channels: ChannelBook;
  readonly #heartbeat: Heartbeat;
  readonly #statusListeners = new Set<() => void>();
  /** The page's record store every window renders out of. */
  readonly store: RecordStore;

  #socket: ClientSocket | null = null;
  #attempt = 0;
  /** The armed reconnect's canceller, and the flag for "one timer in flight, the first wins". */
  #reconnectTimer: (() => void) | null = null;
  /** Set by `close()`: an explicit teardown must not be undone by the close it just triggered. */
  #closed = false;
  #connected = false;
  #reconnectAt: number | null = null;
  #update: string | null = null;

  constructor(options: LiveClientOptions) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? reportToConsole;
    this.store = options.store ?? new RecordStore();
    this.#windows = new RowWindows(this.store);
    this.#channels = new ChannelBook({
      store: this.store,
      send: (frame) => this.#send(frame),
      connected: () => this.#connected,
      catchUp: options.catchUp,
      report: (error) => this.#onError(error),
    });
    this.#heartbeat = new Heartbeat({
      intervalMs: finiteOption(
        'the sync client',
        'heartbeatMs',
        options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS,
      ),
      schedule: options.scheduler ?? timeoutScheduler,
      now: () => this.#clock.now().getTime(),
      beat: () => this.#beat(),
      onSilence: () => this.#silent(),
    });
  }

  get connected(): boolean {
    return this.#connected;
  }

  /** Epoch ms of the next reconnect attempt; `null` while the socket is up. */
  reconnectAt(): number | null {
    return this.#reconnectAt;
  }

  /** The buildId the server announced, or `null` while this build is current. */
  appUpdateAvailable(): string | null {
    return this.#update;
  }

  /** Called after `connected`, `reconnectAt()` or `appUpdateAvailable()` moves. */
  onStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener);
    return () => {
      this.#statusListeners.delete(listener);
    };
  }

  connect(): void {
    this.#closed = false;
    this.#cancelReconnect();
    // The socket we are replacing goes first. Left open, its `onMessage` keeps running: every
    // patch frame applies twice, and the node holds two sockets for one client — double presence
    // membership and double fanout — until the tab closes. Nulled before the close so the corpse's
    // `onClose` takes its own early return rather than marking the new connection offline.
    const previous = this.#socket;
    this.#socket = null;
    previous?.close(1000, 'reconnect');
    // …and because that corpse's `onClose` returns, this is the only place the connection it was
    // carrying can be written off: offline until the NEW socket opens. Reporting the replaced
    // socket's state through the redial sent a live subscription opened in that window straight onto an
    // unopened socket — a subscribe frame ahead of `hello`, then a second one for the same sid
    // when `onOpen` replayed it, which the node refuses with X_SUBSCRIPTION_ID_TAKEN.
    //
    // BEFORE the dial, and that order is the whole fix for the other half: `connect` is app code
    // (`new WebSocket(url)` refuses on mixed content, or on a URL the page may not open) and it
    // may throw. `close()` always got the state right on the way down; this path did none of it,
    // so a refused dial left the client reporting itself online with no socket and no armed timer,
    // marking every later mutation delivered into nothing. It still throws to the caller and still
    // arms nothing — only the reconnect timer owns the retry chain.
    this.#offline();
    const socket = this.#options.connect();
    this.#socket = socket;
    socket.onOpen(() => {
      // A frame speaks only for its own socket — the same guard `onMessage` and `onClose` carry,
      // and the one handler that had none. A replaced socket opening late would otherwise mark the
      // live connection up and replay every subscription onto whatever socket is current.
      if (this.#socket !== socket) return;
      this.#attempt = 0;
      this.#setStatus({ connected: true, reconnectAt: null });
      // `hello` announces the connection and nothing else. Each cursor rides its own `subscribe`
      // frame below, which is the only place resume is decided — sending it here too shipped every
      // cursor twice per reconnect, once into a field the node discards.
      this.#send(this.#hello());
      for (const registration of this.#registrations.values()) this.#sendSubscribe(registration);
      // Channel membership lives on the node's socket and `hello` carries none of it, so every
      // channel is re-announced here — each from its own cursor, so the node replays the rest.
      this.#channels.resubscribe();
      this.#heartbeat.start(this.#clock.now().getTime());
    });
    socket.onMessage((data) => {
      // A frame speaks only for its own socket, the same rule `onClose` follows. A replaced socket
      // that is still draining bytes would otherwise fold its patches into the live registrations
      // a second time, over newer state.
      if (this.#socket !== socket) return;
      this.#heartbeat.saw(this.#clock.now().getTime());
      applyFrame(decode(data), this.#frameTarget);
    });
    socket.onClose(() => {
      // A close speaks only for its own socket: `connect()` may already have installed a newer one,
      // and a corpse marking the live connection offline and arming a backoff is a working socket
      // killed by a dead one. Dropping ours first keeps fire-and-forget `#send` out of the corpse.
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#offline();
      // A `reconnect` frame armed the server's own delay before closing us; rescheduling here would
      // replace the delay the node assigned with a local backoff and re-cluster the herd it spread.
      if (this.#reconnectTimer === null) this.#scheduleReconnect(null);
    });
  }

  /**
   * Everything a lost connection costs, whoever noticed it — a close, a replacement, an explicit
   * teardown, a heartbeat that timed out.
   */
  #offline(): void {
    this.#heartbeat.stop();
    this.#setStatus({ connected: false });
    // Told once, not two ways: a `useConnection().offline` that flips while a live window still
    // reads 'live' is one dead socket rendered as two states. A refused one stays refused.
    for (const registration of this.#registrations.values()) {
      if (registration.state === 'failed' || registration.state === 'offline') continue;
      registration.state = 'offline';
      registration.notify();
    }
    this.#channels.offline();
  }

  /**
   * Explicit teardown: cancels the armed reconnect and drops the socket. Without it a client whose
   * owner is gone keeps waking up and dialling forever — the timer is the only thing still holding
   * it alive. `connect()` starts over, so this is a stop, not a tombstone.
   */
  close(code = 1000, reason = 'client closed'): void {
    this.#closed = true;
    this.#cancelReconnect();
    this.#setStatus({ reconnectAt: null });
    this.#attempt = 0;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(code, reason);
    // The close this triggers is a dropped socket's, so it returns: going offline is our job now.
    this.#offline();
  }

  /**
   * Subscribe to a live query. The window holds ids; the rows are the page store's, so a record
   * updated by an HTTP response or another window re-renders here too, with no second copy.
   */
  subscribeLive<R extends object = JsonObject>(
    query: LiveQueryRef,
    input: JsonValue,
  ): LiveHandle<R> {
    const sid = uuid();
    const listeners = new Set<() => void>();
    const registration: Registration = {
      sid,
      name: query.name,
      input,
      type: unnamedType(query.name),
      ids: [],
      cursor: null,
      // 'loading' is a promise that rows are on their way; with no socket, nothing is on its way.
      state: this.#connected ? 'loading' : 'offline',
      error: undefined,
      notify: () => {
        for (const listener of listeners) listener();
      },
    };
    this.#registrations.set(sid, registration);
    const close = this.#windows.open(registration);
    if (this.#connected) this.#sendSubscribe(registration);
    let open = true;
    const unsubscribe = (): void => {
      if (!open) return;
      open = false;
      this.#registrations.delete(sid);
      close();
      listeners.clear();
      this.#send({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'drop',
        sid,
        target: { kind: 'query', qid: query.name, input, cursor: null },
      });
    };
    return {
      // Rows are typed by the caller's query; on the wire every one is a JSON object.
      rows: () => this.#windows.rows(registration) as readonly R[],
      state: (): LiveState => registration.state,
      cursor: (): LiveCursor | null => registration.cursor,
      error: (): unknown => registration.error,
      onChange: (listener) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
      unsubscribe,
      [Symbol.dispose]: unsubscribe,
    };
  }

  /**
   * Hold a declared channel. N holders on one topic share ONE membership; the last release drops
   * it. Its `records` land in the store; `events` and presence reach `handlers` only.
   */
  holdChannel<K extends string>(
    ref: ChannelRef<K>,
    params: Readonly<Record<K, string>>,
    handlers?: ChannelHandlers,
  ): ChannelMembership {
    return this.#channels.hold(ref, params, handlers);
  }

  #sendSubscribe(registration: Registration): void {
    this.#send({
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'add',
      sid: registration.sid,
      target: {
        kind: 'query',
        qid: registration.name,
        input: registration.input,
        cursor: registration.cursor,
      },
    });
  }

  /**
   * The client's inbound surface, handed to the router. Built once: a frame reaches exactly these
   * members and nothing else on the client.
   */
  get #frameTarget(): ClientFrameTarget {
    return {
      registration: (sid) => this.#registrations.get(sid),
      windows: this.#windows,
      channels: this.#channels,
      // The client's clock, never `Date.now()`: a cursor's `at` is what decides a delta resume
      // against a re-snapshot, so the frame path reads the same clock every other path does.
      now: () => this.#clock.now().getTime(),
      setUpdate: (buildId) => this.#setStatus({ update: buildId }),
      scheduleReconnect: (afterMs) => this.#scheduleReconnect(afterMs),
      closeSocket: (code, reason) => this.#socket?.close(code, reason),
      report: (error) => this.#onError(error),
    };
  }

  /** The opening frame, and the heartbeat's. One shape, because it makes one claim: I am here. */
  #hello(): Frame {
    return {
      type: 'hello',
      v: PROTOCOL_VERSION,
      buildId: this.#options.buildId,
      sessionId: null,
      actorId: this.#options.actorId ?? null,
    };
  }

  /**
   * One liveness pass, and it buys exactly two things. `hello` provokes an answer on any socket,
   * which is the only way a browser learns a half-open one is dead — nothing else ever will, since
   * a half-open socket fires no `onClose`. Re-sending each topic is the node's own presence
   * heartbeat: subscribing IS being in the room, so a client that stopped repeating it is swept
   * out of every room it is still receiving from.
   *
   * It is NOT how a deploy is noticed. `socket.skewed` compares the build id this client says —
   * the `hello`'s own `buildId`, the same on every beat, or `?build=` on the dial — against the
   * node's, and neither moves while the socket is open, so every `hello` on one socket gets the
   * same answer forever; `update-available` reaches a client on the socket it opens against the
   * *new* node, which is a reconnect and never a beat.
   */
  #beat(): void {
    this.#send(this.#hello());
    this.#channels.beat();
  }

  /**
   * Nothing has come back for two heartbeat windows. A half-open socket fires no `onClose` — that
   * is what makes it half-open — so this client is the only thing that can end it. It is dropped
   * here rather than awaited: a browser `close()` on a black-holed connection can sit in CLOSING
   * until the TCP close handshake times out, and the reconnect must not wait that out.
   */
  #silent(): void {
    const socket = this.#socket;
    this.#socket = null;
    this.#offline();
    socket?.close(HEARTBEAT_TIMEOUT_CODE, 'heartbeat timeout');
    if (this.#reconnectTimer === null) this.#scheduleReconnect(null);
  }

  /**
   * Honours a server-assigned delay when there is one; otherwise jittered exponential backoff.
   * Publishing `reconnectAt` is the render half — arming the timer is the half that makes the
   * client come back, and `connect()` is the only thing it calls.
   */
  #scheduleReconnect(serverDelayMs: number | null): void {
    if (this.#closed) return;
    this.#cancelReconnect();
    const rng = this.#options.rng ?? Math.random;
    const delay =
      serverDelayMs ?? backoffDelay(this.#attempt, this.#options.backoff ?? browserBackoff, rng);
    this.#attempt += 1;
    this.#setStatus({ reconnectAt: this.#clock.now().getTime() + delay });
    const schedule = this.#options.scheduler ?? timeoutScheduler;
    this.#reconnectTimer = schedule(() => {
      // Cleared before dialling, not after: the attempt's own close must be free to arm the next
      // one. `reconnectAt` stays put until the socket opens, so a countdown does not blink to null.
      this.#reconnectTimer = null;
      if (this.#closed) return;
      try {
        this.connect();
      } catch (error) {
        // A socket constructor may refuse (mixed content, a URL the page may not open), and one
        // refusal ending the chain is the same outage as never arming — so the next attempt is put
        // on first. Reported, never rethrown: nothing awaits a timer, so a throw out of one is an
        // uncaught exception that can kill the process that was going to retry. Only this path
        // changes — a `connect()` the app called itself still throws to it, and still arms nothing.
        this.#scheduleReconnect(null);
        this.#onError(error);
      }
    }, delay);
  }

  #cancelReconnect(): void {
    const cancel = this.#reconnectTimer;
    this.#reconnectTimer = null;
    cancel?.();
  }

  #send(frame: Frame): void {
    this.#socket?.send(encode(frame));
  }

  /** One status write, one notification — and none for a write that changed nothing. */
  #setStatus(next: {
    connected?: boolean;
    reconnectAt?: number | null;
    update?: string | null;
  }): void {
    let moved = false;
    if (next.connected !== undefined && next.connected !== this.#connected) {
      this.#connected = next.connected;
      moved = true;
    }
    if (next.reconnectAt !== undefined && next.reconnectAt !== this.#reconnectAt) {
      this.#reconnectAt = next.reconnectAt;
      moved = true;
    }
    if (next.update !== undefined && next.update !== this.#update) {
      this.#update = next.update;
      moved = true;
    }
    if (moved) for (const listener of this.#statusListeners) listener();
  }
}
