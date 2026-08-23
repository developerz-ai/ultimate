// What a client IS, as types: the injected seams, the options, and the handles a subscription
// gives back. Declared apart from the client that implements them for the same reason
// `live-contract.ts` is — the hooks, the typed projection, the type pins and the mutation path all
// need these shapes, and none of them needs the connection lifecycle that runs underneath.

import type { Clock } from '@ultimat3/core';
import type { LiveCursor } from './cursor';
import type { JsonValue, Row } from './json';
import type { LiveState } from './live-rows';
import type { LocalStore, LocalTx, TableMap } from './local-store';
import type { OfflineQueue } from './offline-queue';
import type { ConflictStrategy, RebaseLog } from './rebase';
import type { BackoffPolicy, Rng, Scheduler } from './thundering-herd';

/** Injected reactive primitive. `createSignal` from Solid satisfies this exactly. */
export type SignalFactory = <T>(initial: T) => [get: () => T, set: (next: T) => void];

/** Injected socket, so tests drive the protocol without a network. */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
  /**
   * Bytes queued but not yet on the wire — `WebSocket.bufferedAmount`. Optional because a socket
   * that cannot answer is treated as never backed up; supplying it is what lets the mutation drain
   * stop instead of pushing a queue the tab is not draining into one it cannot see.
   */
  readonly bufferedAmount?: number;
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

/**
 * What the HOOKS need a client to be — every member `hooks.ts` reads, and not one more.
 *
 * A structural interface rather than the `LiveClient` class, and the reason is measured: a value
 * import of that class from the hook seam put the whole connection lifecycle (heartbeat, topic
 * book, mutation sender, wire protocol, backoff) into every island that calls `useLive`, taking a
 * `useLive`-only browser chunk from 8,368 B to 26,571 B. The server render's client
 * (`server-render-client.ts`) satisfies this and imports no lifecycle at all, so the browser pays
 * nothing for a shape only the server uses. `type-pins.ts` pins that `LiveClient` still satisfies
 * it, so a member added there and not here is a build error rather than a hook that cannot see it.
 */
export interface LiveClientLike<T extends TableMap = TableMap> {
  readonly signal: SignalFactory;
  readonly queue: OfflineQueue | undefined;
  readonly connected: boolean;
  readonly reconnectAt: () => number | null;
  readonly appUpdateAvailable: () => string | null;
  useLive<R extends Row>(query: LiveQueryRef, input: JsonValue): LiveHandle<R>;
  mutate(mutator: MutatorRef<T>, input: JsonValue, key?: string): Promise<void>;
  drain(): Promise<void>;
  onQueueChange(listener: () => void): () => void;
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
  /**
   * How often a live socket re-announces itself, in ms. `0` disables it. Defaults to
   * `DEFAULT_HEARTBEAT_MS`, 15s. The one knob for the beat: `realtime.heartbeatMs` in
   * `app.config.ts` was deleted 2026-08-19 because nothing read it, so this is not a restatement
   * of a server value — browser code could never have reached one.
   */
  readonly heartbeatMs?: number;
  /** Where a dial failure inside the reconnect timer is reported. Defaults to `reportToConsole`. */
  readonly onError?: (error: unknown) => void;
}
