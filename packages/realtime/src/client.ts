// The client half. Framework-agnostic on purpose: the reactive primitive is injected, so this
// package never imports solid-js and can be exercised by `bun test` with two closures. One client
// serves all three tiers: `useLive` is tier 2, and a `store` + `queue` makes the same call tier 3
// with nothing about the subscription changing — that is the ladder's whole promise.

import { type Clock, finiteOption, systemClock, uuid } from '@ultimat3/core';
import type { Topic } from './channel';
import type {
  ClientSocket,
  LiveClientOptions,
  LiveHandle,
  LiveQueryRef,
  MutatorRef,
  SignalFactory,
  Unsubscribe,
} from './client-contract';
import { applyFrame, type ClientFrameTarget } from './client-frames';
import { DEFAULT_HEARTBEAT_MS, Heartbeat } from './client-heartbeat';
import { type MutationDeps, mutationSender, recordMutation } from './client-mutations';
import { TopicBook, topicSubscribeFrame } from './client-topics';
import type { LiveCursor } from './cursor';
import { IdentityMap, privateScope } from './identity-map';
import type { JsonObject, JsonValue, Row } from './json';
import { type LiveState, type Registration, RowWindows } from './live-rows';
import type { TableMap } from './local-store';
import type { OfflineQueue } from './offline-queue';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';
import { backoffDelay, defaultBackoff, timeoutScheduler } from './thundering-herd';

/**
 * The client's own shapes, re-exported from where they are declared: an app imports `ClientSocket`
 * and `LiveClientOptions` from the client it configures, not from a file it never names.
 */
export type {
  ClientSocket,
  LiveClientLike,
  LiveClientOptions,
  LiveHandle,
  LiveQueryRef,
  MutatorRef,
  SignalFactory,
  Unsubscribe,
} from './client-contract';

/** The four states a live subscription renders. Declared with the window that holds them. */
export type { LiveState } from './live-rows';

/** Private-use close code (4000–4999), so a heartbeat timeout is distinguishable in a log. */
const HEARTBEAT_TIMEOUT_CODE = 4000;

/** The default reporter: `console.error`, never core's `logger` — that writes `process.stderr`. */
const reportToConsole = (error: unknown): void => {
  console.error(error);
};

export class LiveClient<T extends TableMap = TableMap> {
  readonly #options: LiveClientOptions<T>;
  readonly #clock: Clock;
  readonly #onError: (error: unknown) => void;
  readonly #registrations = new Map<string, Registration>();
  readonly #windows: RowWindows;
  readonly #topics = new TopicBook();
  readonly #heartbeat: Heartbeat;
  readonly #setUpdate: (buildId: string | null) => void;
  readonly #setReconnectAt: (at: number | null) => void;

  readonly appUpdateAvailable: () => string | null;
  readonly reconnectAt: () => number | null;
  /**
   * The reactive primitive the app injected, re-exposed so anything built on this client derives
   * its signals from the same runtime. One reactive runtime per app, never two.
   */
  readonly signal: SignalFactory;
  /** The durable queue when tier 3 is configured, so a queue count is read off the queue itself. */
  readonly queue: OfflineQueue | undefined;
  /**
   * One row value per `(entity, id)` for this client. Taken from the local store when tier 3 is
   * configured, so an optimistic write and the live query rendering that row are the same row —
   * a second map here would be exactly the duplication an identity map exists to prevent.
   */
  readonly identity: IdentityMap;

  #socket: ClientSocket | null = null;
  #attempt = 0;
  /** The armed reconnect's canceller, and the flag for "one timer in flight, the first wins". */
  #reconnectTimer: (() => void) | null = null;
  /** Set by `close()`: an explicit teardown must not be undone by the close it just triggered. */
  #closed = false;
  /** A signal, not a field: `connected` is rendered, so a plain boolean would never re-render. */
  readonly #connected: () => boolean;
  readonly #setConnected: (next: boolean) => void;
  /** Notified after every offline-queue mutation; `onQueueChange` says who subscribes, and why. */
  readonly #queueListeners = new Set<() => void>();

  constructor(options: LiveClientOptions<T>) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.#onError = options.onError ?? reportToConsole;
    this.signal = options.signal;
    this.queue = options.queue;
    this.identity = options.store?.identity ?? new IdentityMap();
    this.#windows = new RowWindows(this.identity);
    const [update, setUpdate] = options.signal<string | null>(null);
    const [reconnectAt, setReconnectAt] = options.signal<number | null>(null);
    const [connected, setConnected] = options.signal<boolean>(false);
    this.appUpdateAvailable = update;
    this.#setUpdate = setUpdate;
    this.reconnectAt = reconnectAt;
    this.#setReconnectAt = setReconnectAt;
    this.#connected = connected;
    this.#setConnected = setConnected;
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
    return this.#connected();
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
    // socket's state through the redial sent a `useLive` opened in that window straight onto an
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
      this.#setConnected(true);
      this.#attempt = 0;
      this.#setReconnectAt(null);
      // `hello` announces the connection and nothing else. Each cursor rides its own `subscribe`
      // frame below, which is the only place resume is decided — sending it here too shipped every
      // cursor twice per reconnect, once into a field the node discards.
      this.#send(this.#hello());
      for (const registration of this.#registrations.values()) this.#sendSubscribe(registration);
      // Topic membership lives on the node's socket and `hello` carries none of it, so a channel
      // this client still holds a handler for is silent from the first reconnect onwards — and its
      // presence membership is swept — unless every one of them is re-announced here.
      for (const name of this.#topics.names()) this.#send(topicSubscribeFrame(name, 'add'));
      this.#heartbeat.start(this.#clock.now().getTime());
      this.#detach(this.drain());
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
   * teardown, a heartbeat that timed out. The queue half is the one that is easy to forget: a
   * mutation handed to a socket that is now gone was never acknowledged, so it goes back in the
   * queue rather than waiting for an ack nobody will send.
   */
  #offline(): void {
    this.#heartbeat.stop();
    this.#setConnected(false);
    // Told once, not two ways: a `useConnection().offline` that flips while a `useLive` handle
    // still reads 'live' is one dead socket rendered as two states.
    for (const registration of this.#registrations.values()) registration.setState('offline');
    const queue = this.#options.queue;
    if (queue) this.#detach(queue.requeueInflight());
  }

  /**
   * Explicit teardown: cancels the armed reconnect and drops the socket. Without it a client whose
   * owner is gone keeps waking up and dialling forever — the timer is the only thing still holding
   * it alive. `connect()` starts over, so this is a stop, not a tombstone.
   */
  close(code = 1000, reason = 'client closed'): void {
    this.#closed = true;
    this.#cancelReconnect();
    this.#setReconnectAt(null);
    this.#attempt = 0;
    const socket = this.#socket;
    this.#socket = null;
    socket?.close(code, reason);
    // The close this triggers is a dropped socket's, so it returns: going offline is our job now.
    this.#offline();
  }

  /** Tier 2 and tier 3 alike. The returned accessor is the reactive result set. */
  useLive<R extends Row = Row>(query: LiveQueryRef, input: JsonValue): LiveHandle<R> {
    const sid = uuid();
    const [rows, setRows] = this.#options.signal<readonly Row[]>([]);
    // 'loading' is a promise that rows are on their way; with no socket, nothing is on its way.
    const [state, setState] = this.#options.signal<LiveState>(
      this.#connected() ? 'loading' : 'offline',
    );
    const [cursor, setCursor] = this.#options.signal<LiveCursor | null>(null);
    const registration: Registration = {
      sid,
      name: query.name,
      input,
      setRows,
      setState,
      setCursor,
      // Private until the first snapshot names the entity: sharing rows with another query on a
      // scope nobody confirmed would merge two entities that spell one id the same way.
      scope: privateScope(query.name),
      ids: [],
      cursor: null,
    };
    this.#registrations.set(sid, registration);
    const close = this.#windows.open(registration);
    if (this.#connected()) this.#sendSubscribe(registration);
    const unsubscribe = (): void => {
      this.#registrations.delete(sid);
      close();
      this.#send({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'drop',
        sid,
        target: { kind: 'query', qid: query.name, input, cursor: null },
      });
    };
    return {
      rows: rows as () => readonly R[],
      state,
      cursor,
      unsubscribe,
      [Symbol.dispose]: unsubscribe,
    };
  }

  subscribe(name: Topic, handler: (message: JsonObject) => void): Unsubscribe {
    this.#topics.add(name, handler);
    this.#send(topicSubscribeFrame(name, 'add'));
    // A function is an object: attaching `[Symbol.dispose]` keeps the existing callable contract
    // (`const unsub = channel.subscribe(...); unsub()`) intact while adding `using sub = ...`.
    const unsubscribe: Unsubscribe = (): void => {
      if (!this.#topics.remove(name, handler)) return;
      this.#send(topicSubscribeFrame(name, 'drop'));
    };
    unsubscribe[Symbol.dispose] = unsubscribe;
    return unsubscribe;
  }

  /** Tier 1 publish. The server re-checks the topic policy; this is a request, not an assertion. */
  publish(name: Topic, message: JsonObject): void {
    this.#send({
      type: 'patch',
      v: PROTOCOL_VERSION,
      sid: name,
      lsn: '',
      patches: [{ op: 'insert', id: uuid(), row: message, lsn: '' }],
    });
  }

  /**
   * The mutator entry point. Records the optimistic twin, the rebase entry and the durable queue
   * entry, then drains. Offline, everything but the drain still happens — that is tier 3's one
   * extra property over tier 2.
   */
  async mutate(mutator: MutatorRef<T>, input: JsonValue, key?: string): Promise<void> {
    await recordMutation(this.#mutations, mutator, input, key);
    if (this.#options.queue) await this.drain();
  }

  /** Sends every pending mutation in sequence order. Stops at the first one the socket refuses. */
  async drain(): Promise<void> {
    const queue = this.#options.queue;
    if (!queue || !this.#connected()) return;
    await queue.drain(mutationSender(this.#mutations));
    this.#notifyQueueChange();
  }

  /** The mutation path's view of this client. Built per call, exactly like `#frameTarget`. */
  get #mutations(): MutationDeps<T> {
    return {
      store: this.#options.store,
      queue: this.#options.queue,
      log: this.#options.log,
      now: () => this.#clock.now().getTime(),
      socket: () => this.#socket,
      send: (frame) => this.#send(frame),
    };
  }

  /**
   * Fires whenever the offline queue changes for any reason: a direct `mutate`/`drain` call, the
   * automatic drain `connect()` runs on every reconnect, or an async ack/fail frame arriving over
   * the socket. `hooks.ts` is the only subscriber today — it bumps its invalidation signal here at
   * `setLiveClient` time, so a component reading `useMutationQueue()` stays live across every
   * transition, not just the ones a hook happens to await directly. Returns an unsubscribe
   * function.
   */
  onQueueChange(listener: () => void): () => void {
    this.#queueListeners.add(listener);
    return () => {
      this.#queueListeners.delete(listener);
    };
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
  get #frameTarget(): ClientFrameTarget<T> {
    return {
      registration: (sid) => this.#registrations.get(sid),
      windows: this.#windows,
      topicHandlers: (topic) => this.#topics.handlers(topic),
      queue: this.#options.queue,
      store: this.#options.store,
      log: this.#options.log,
      // The client's clock, never `Date.now()`: a cursor's `at` is what decides a delta resume
      // against a re-snapshot, so the frame path reads the same clock every other path does.
      now: () => this.#clock.now().getTime(),
      setUpdate: (buildId) => this.#setUpdate(buildId),
      scheduleReconnect: (afterMs) => this.#scheduleReconnect(afterMs),
      closeSocket: (code, reason) => this.#socket?.close(code, reason),
      notifyQueueChange: () => this.#notifyQueueChange(),
      detach: (work) => this.#detach(work),
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
   * It is NOT how a deploy is noticed. `socket.skewed` compares the build id the upgrade recorded
   * against this node's, both fixed for the socket's whole life, so every `hello` on one socket
   * gets the same answer forever; `update-available` reaches a client on the socket it opens
   * against the *new* node, which is a reconnect and never a beat.
   */
  #beat(): void {
    this.#send(this.#hello());
    for (const name of this.#topics.names()) this.#send(topicSubscribeFrame(name, 'add'));
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
      serverDelayMs ?? backoffDelay(this.#attempt, this.#options.backoff ?? defaultBackoff, rng);
    this.#attempt += 1;
    this.#setReconnectAt(this.#clock.now().getTime() + delay);
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

  /**
   * Work nobody awaits: the drain `onOpen` runs, a queue write from a socket that just died. It
   * bottoms out in `QueueStore.save()` — OPFS or IndexedDB, both allowed to reject — and an
   * unhandled rejection in a tab is `window.onerror`, in Bun a dead process. `onError` is the seam
   * the reconnect timer already reports through; it is never `logger`, which writes stderr.
   */
  #detach(work: Promise<unknown>): void {
    void work.catch(this.#onError);
  }

  #notifyQueueChange(): void {
    for (const listener of this.#queueListeners) listener();
  }
}
