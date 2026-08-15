// The client half. Framework-agnostic on purpose: the reactive primitive is injected, so this
// package never imports solid-js and can be exercised by `bun test` with two closures. One client
// serves all three tiers: `useLive` is tier 2, and a `store` + `queue` makes the same call tier 3
// with nothing about the subscription changing — that is the ladder's whole promise.

import { type Clock, systemClock, uuid } from '@ultimat3/core';
import type { Topic } from './channel';
import { applyFrame, type ClientFrameTarget } from './client-frames';
import type { LiveCursor } from './cursor';
import { IdentityMap, privateScope } from './identity-map';
import type { JsonObject, JsonValue, Row } from './json';
import { type LiveState, type Registration, RowWindows } from './live-rows';
import type { LocalStore, LocalTx, TableMap } from './local-store';
import { mutateFrame, type OfflineQueue } from './offline-queue';
import type { ConflictStrategy, RebaseLog } from './rebase';
import { decode, encode, type Frame, PROTOCOL_VERSION } from './sync-protocol';
import {
  type BackoffPolicy,
  backoffDelay,
  defaultBackoff,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';

/** The four states a live subscription renders. Declared with the window that holds them. */
export type { LiveState } from './live-rows';

/** Injected reactive primitive. `createSignal` from Solid satisfies this exactly. */
export type SignalFactory = <T>(initial: T) => [get: () => T, set: (next: T) => void];

/** Injected socket, so tests drive the protocol without a network. */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
}

export interface LiveHandle<R extends Row = Row> extends Disposable {
  /** The reactive accessor. In an app this is the Solid signal `useLive` returns. */
  readonly rows: () => readonly R[];
  readonly state: () => LiveState;
  readonly cursor: () => LiveCursor | null;
  unsubscribe(): void;
  /** The same call as `unsubscribe`, so `using sub = client.useLive(...)` just works. */
  [Symbol.dispose](): void;
}

/** What `subscribe()` returns for a tier-1 topic: callable to unsubscribe, and `using`-able too. */
export type Unsubscribe = (() => void) & Disposable;

export interface LiveQueryRef {
  readonly name: string;
}

export interface MutatorRef<T extends TableMap = TableMap> {
  readonly name: string;
  /** Optimistic twin. Pure — no I/O, no Date.now(), no Math.random(). */
  local?: (tx: LocalTx<T>, input: JsonValue) => void;
  readonly entity?: string;
  readonly conflict?: ConflictStrategy;
}

export interface LiveClientOptions<T extends TableMap = TableMap> {
  readonly signal: SignalFactory;
  /** Called for every connect attempt; returning a fresh socket keeps reconnect logic here. */
  readonly connect: () => ClientSocket;
  readonly buildId: string;
  readonly actorId?: string | null;
  /** Tier 3 only. Without these, mutations are server-only and nothing is queued offline. */
  readonly store?: LocalStore<T>;
  readonly queue?: OfflineQueue;
  readonly log?: RebaseLog<T>;
  readonly backoff?: BackoffPolicy;
  readonly rng?: Rng;
  readonly clock?: Clock;
  /** How a pending reconnect is armed. Defaults to `setTimeout`; tests fire theirs by hand. */
  readonly scheduler?: Scheduler;
  /** Where a dial failure inside the reconnect timer is reported. Defaults to `reportToConsole`. */
  readonly onError?: (error: unknown) => void;
}

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
  readonly #topics = new Map<string, Set<(message: JsonObject) => void>>();
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
    const socket = this.#options.connect();
    this.#socket = socket;
    socket.onOpen(() => {
      this.#setConnected(true);
      this.#attempt = 0;
      this.#setReconnectAt(null);
      this.#send({
        type: 'hello',
        v: PROTOCOL_VERSION,
        buildId: this.#options.buildId,
        sessionId: null,
        actorId: this.#options.actorId ?? null,
        resume: [...this.#registrations.values()]
          .map((registration) => registration.cursor)
          .filter((cursor): cursor is LiveCursor => cursor !== null),
      });
      for (const registration of this.#registrations.values()) this.#sendSubscribe(registration);
      void this.drain();
    });
    socket.onMessage((data) => {
      // A frame speaks only for its own socket, the same rule `onClose` follows. A replaced socket
      // that is still draining bytes would otherwise fold its patches into the live registrations
      // a second time, over newer state.
      if (this.#socket !== socket) return;
      applyFrame(decode(data), this.#frameTarget);
    });
    socket.onClose(() => {
      // A close speaks only for its own socket: `connect()` may already have installed a newer one,
      // and a corpse marking the live connection offline and arming a backoff is a working socket
      // killed by a dead one. Dropping ours first keeps fire-and-forget `#send` out of the corpse.
      if (this.#socket !== socket) return;
      this.#socket = null;
      this.#setConnected(false);
      for (const registration of this.#registrations.values()) registration.setState('offline');
      // A `reconnect` frame armed the server's own delay before closing us; rescheduling here would
      // replace the delay the node assigned with a local backoff and re-cluster the herd it spread.
      if (this.#reconnectTimer === null) this.#scheduleReconnect(null);
    });
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
    this.#setConnected(false);
    // The close this triggers is a dropped socket's, so it returns: going offline is our job now.
    for (const registration of this.#registrations.values()) registration.setState('offline');
  }

  /** Tier 2 and tier 3 alike. The returned accessor is the reactive result set. */
  useLive<R extends Row = Row>(query: LiveQueryRef, input: JsonValue): LiveHandle<R> {
    const sid = uuid();
    const [rows, setRows] = this.#options.signal<readonly Row[]>([]);
    const [state, setState] = this.#options.signal<LiveState>('loading');
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
    const handlers = this.#topics.get(name) ?? new Set<(message: JsonObject) => void>();
    handlers.add(handler);
    this.#topics.set(name, handlers);
    this.#send({
      type: 'subscribe',
      v: PROTOCOL_VERSION,
      op: 'add',
      sid: name,
      target: { kind: 'topic', topic: name },
    });
    // A function is an object: attaching `[Symbol.dispose]` keeps the existing callable contract
    // (`const unsub = channel.subscribe(...); unsub()`) intact while adding `using sub = ...`.
    const unsubscribe: Unsubscribe = (): void => {
      handlers.delete(handler);
      if (handlers.size > 0) return;
      this.#topics.delete(name);
      this.#send({
        type: 'subscribe',
        v: PROTOCOL_VERSION,
        op: 'drop',
        sid: name,
        target: { kind: 'topic', topic: name },
      });
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
   * The mutator entry point. Applies the optimistic twin, records a rebase entry, queues durably,
   * then drains. Offline, everything but the drain still happens — that is tier 3's one extra
   * property over tier 2.
   */
  async mutate(mutator: MutatorRef<T>, input: JsonValue, key?: string): Promise<void> {
    const idempotencyKey = key ?? `${mutator.name}:${uuid()}`;
    const store = this.#options.store;
    const queue = this.#options.queue;
    const local = mutator.local;
    const queued = await queue?.enqueue({
      key: idempotencyKey,
      name: mutator.name,
      input,
      at: this.#clock.now().getTime(),
    });
    if (store && local) {
      store.apply(idempotencyKey, (tx) => local(tx, input));
      this.#options.log?.record({
        key: idempotencyKey,
        seq: queued?.seq ?? 0,
        entity: mutator.entity ?? mutator.name,
        strategy: mutator.conflict ?? 'server-wins',
        apply: (tx) => local(tx, input),
      });
    }
    if (!queue) {
      this.#send(
        mutateFrame({
          key: idempotencyKey,
          seq: 0,
          name: mutator.name,
          input,
          enqueuedAt: this.#clock.now().getTime(),
          attempts: 0,
          status: 'pending',
          error: null,
        }),
      );
      return;
    }
    await this.drain();
  }

  /** Sends every pending mutation in sequence order. Stops at the first one the socket refuses. */
  async drain(): Promise<void> {
    const queue = this.#options.queue;
    if (!queue || !this.#connected()) return;
    await queue.drain(async (mutation) => {
      this.#send(mutateFrame(mutation));
    });
    this.#notifyQueueChange();
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
      topicHandlers: (topic) => this.#topics.get(topic),
      queue: this.#options.queue,
      store: this.#options.store,
      log: this.#options.log,
      setUpdate: (buildId) => this.#setUpdate(buildId),
      scheduleReconnect: (afterMs) => this.#scheduleReconnect(afterMs),
      closeSocket: (code, reason) => this.#socket?.close(code, reason),
      notifyQueueChange: () => this.#notifyQueueChange(),
    };
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

  #notifyQueueChange(): void {
    for (const listener of this.#queueListeners) listener();
  }
}
