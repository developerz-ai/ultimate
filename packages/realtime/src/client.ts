// The client half. Framework-agnostic on purpose: the reactive primitive is injected, so this
// package never imports solid-js and can be exercised by `bun test` with two closures.
//
// One client serves all three tiers. `useLive` is tier 2; passing a `store` + `queue` makes the
// same call tier 3. Nothing about the subscription changes — that is the ladder's whole promise.

import { type Clock, systemClock, uuid } from '@ultimat3/core';
import { applyPatches } from './apply-patches';
import type { Topic } from './channel';
import type { LiveCursor } from './cursor';
import type { JsonObject, JsonValue, Row } from './json';
import type { LocalStore, LocalTx, TableMap } from './local-store';
import { mutateFrame, type OfflineQueue } from './offline-queue';
import { type ConflictStrategy, type RebaseLog, reconcile } from './rebase';
import { decode, encode, type Frame, PROTOCOL_VERSION, type PresenceMember } from './sync-protocol';
import {
  type BackoffPolicy,
  backoffDelay,
  defaultBackoff,
  type Rng,
  type Scheduler,
  timeoutScheduler,
} from './thundering-herd';

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

export type LiveState = 'loading' | 'live' | 'stale' | 'offline';

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
}

interface Registration {
  readonly sid: string;
  readonly name: string;
  readonly input: JsonValue;
  readonly setRows: (rows: readonly Row[]) => void;
  readonly setState: (state: LiveState) => void;
  readonly setCursor: (cursor: LiveCursor | null) => void;
  rows: readonly Row[];
  cursor: LiveCursor | null;
}

export class LiveClient<T extends TableMap = TableMap> {
  readonly #options: LiveClientOptions<T>;
  readonly #clock: Clock;
  readonly #registrations = new Map<string, Registration>();
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

  #socket: ClientSocket | null = null;
  #attempt = 0;
  /** The armed reconnect's canceller, and the flag for "one timer in flight, the first wins". */
  #reconnectTimer: (() => void) | null = null;
  /** Set by `close()`: an explicit teardown must not be undone by the close it just triggered. */
  #closed = false;
  /** A signal, not a field: `connected` is rendered, so a plain boolean would never re-render. */
  readonly #connected: () => boolean;
  readonly #setConnected: (next: boolean) => void;
  /**
   * Subscribers notified after every offline-queue mutation: a manual drain, the automatic drain
   * `connect()` runs on every reconnect, or an async ack/fail frame. `hooks.ts` wires its
   * invalidation signal through `onQueueChange` rather than each call site remembering to bump it
   * itself — see there for why that matters.
   */
  readonly #queueListeners = new Set<() => void>();

  constructor(options: LiveClientOptions<T>) {
    this.#options = options;
    this.#clock = options.clock ?? systemClock;
    this.signal = options.signal;
    this.queue = options.queue;
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
      this.#onFrame(decode(data));
    });
    socket.onClose(() => {
      // Drop the dead socket before anything can write to it: `#send` is fire-and-forget, so a
      // retained reference turns every later frame into a silent no-op the caller believes landed.
      if (this.#socket === socket) this.#socket = null;
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
      rows: [],
      cursor: null,
    };
    this.#registrations.set(sid, registration);
    if (this.#connected()) this.#sendSubscribe(registration);
    const unsubscribe = (): void => {
      this.#registrations.delete(sid);
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

  #onFrame(frame: Frame): void {
    switch (frame.type) {
      case 'snapshot': {
        const registration = this.#registrations.get(frame.sid);
        if (!registration) return;
        registration.rows = frame.rows;
        registration.cursor = frame.cursor;
        registration.setRows(frame.rows);
        registration.setCursor(frame.cursor);
        registration.setState('live');
        return;
      }
      case 'patch': {
        const registration = this.#registrations.get(frame.sid);
        if (registration) {
          registration.rows = applyPatches(registration.rows, frame.patches);
          registration.setRows(registration.rows);
          registration.setState('live');
          return;
        }
        // No registration: it is a tier-1 channel message on `sid = topic`.
        const handlers = this.#topics.get(frame.sid);
        if (!handlers) return;
        for (const patch of frame.patches) {
          if (patch.row === null) continue;
          for (const handler of handlers) handler(patch.row);
        }
        return;
      }
      case 'ack': {
        const queue = this.#options.queue;
        // `ack`/`fail` mutate the queue synchronously and persist asynchronously; chaining rather
        // than notifying right after the call keeps this correct even if that ordering ever
        // changes, and it still fires exactly once the persisted write actually lands.
        const settled = frame.error ? queue?.fail(frame.ref, frame.error) : queue?.ack(frame.ref);
        void settled?.then(() => this.#notifyQueueChange());
        return;
      }
      case 'rebase': {
        const store = this.#options.store;
        const log = this.#options.log;
        if (!store || !log) return;
        reconcile({
          store,
          log,
          ack: {
            key: frame.key,
            entity: frame.entity,
            id: frame.row?.id ?? frame.key,
            row: frame.row,
          },
        });
        return;
      }
      case 'reconnect': {
        // Order is load-bearing: arming first is what makes the close this triggers keep the delay
        // the node assigned to *this* socket instead of falling back to a local backoff.
        this.#scheduleReconnect(frame.afterMs);
        this.#socket?.close(1001, frame.reason);
        return;
      }
      case 'update-available': {
        this.#setUpdate(frame.buildId);
        return;
      }
      case 'presence': {
        const handlers = this.#topics.get(frame.topic);
        if (!handlers) return;
        const message: JsonObject = { op: frame.op, members: frame.members.map(memberJson) };
        for (const handler of handlers) handler(message);
        return;
      }
      case 'hello':
      case 'subscribe':
      case 'mutate':
        // Client-authored frames: never received. Ignored rather than thrown, so a future
        // bidirectional use of the same kind cannot break an old client.
        return;
    }
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
        // A socket constructor that throws (mixed content, a URL the page may not open) would
        // otherwise end the chain here — this attempt failed, so it counts as one and the next is
        // armed before the error leaves. Rethrown, never swallowed: the host still reports it.
        this.#scheduleReconnect(null);
        throw error;
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

function memberJson(member: PresenceMember): JsonValue {
  return { id: member.id, actorId: member.actorId, meta: member.meta, updatedAt: member.updatedAt };
}
