// What a client IS, as types: the injected seams, the options, and the handles a subscription
// gives back. Declared apart from the client that implements them, so a hook module can name the
// shapes without importing the connection lifecycle underneath — and the bytes that come with it.

import type { Clock, Row } from '@ultimat3/core/page';
import type { LiveCursor } from './cursor';
import type { LiveState } from './live-rows';
import type { RecordStore } from './record-store';
import type { BackoffPolicy, Rng, Scheduler } from './thundering-herd';

/**
 * A reactive primitive: `createSignal` narrowed to two functions. Installed PER ISLAND BUNDLE
 * (`installRealtime`), because every island carries its own solid-js and a signal made by one
 * bundle's copy is invisible to another's effects.
 */
export type SignalFactory = <T>(initial: T) => [get: () => T, set: (next: T) => void];

/**
 * The socket seam. `browser-socket.ts` is the one production implementation — the only
 * `new WebSocket` in the framework — and test harnesses supply their own. Not on the public API:
 * an app never constructs a socket, the page does.
 */
export interface ClientSocket {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onOpen(handler: () => void): void;
  onMessage(handler: (data: string) => void): void;
  onClose(handler: (code: number) => void): void;
  readonly bufferedAmount?: number;
}

/** One live query's window, as plain reads plus a change listener — no reactive runtime here. */
export interface LiveHandle<R extends object = Row> extends Disposable {
  rows(): readonly R[];
  state(): LiveState;
  cursor(): LiveCursor | null;
  /** What the node answered when it refused the subscription; `undefined` unless `failed`. */
  error(): unknown;
  /** Called after anything the reads above answer has moved. Returns the unsubscribe. */
  onChange(listener: () => void): () => void;
  unsubscribe(): void;
  /** The same call as `unsubscribe`, so `using sub = client.subscribeLive(...)` just works. */
  [Symbol.dispose](): void;
}

/** What `subscribe()` returns for a tier-1 topic: callable to unsubscribe, and `using`-able too. */
export type Unsubscribe = (() => void) & Disposable;

export interface LiveQueryRef {
  readonly name: string;
}

export interface LiveClientOptions {
  /** Called for every connect attempt; returning a fresh socket keeps reconnect logic here. */
  readonly connect: () => ClientSocket;
  readonly buildId: string;
  readonly actorId?: string | null;
  /** The page's record store every window renders out of. A client builds its own when absent. */
  readonly store?: RecordStore;
  /** Default `browserBackoff`: capped at `BROWSER_RECONNECT_MAX_MS`, never the server's 30s. */
  readonly backoff?: BackoffPolicy;
  readonly rng?: Rng;
  readonly clock?: Clock;
  /** How a pending reconnect is armed. Defaults to `setTimeout`; tests fire theirs by hand. */
  readonly scheduler?: Scheduler;
  /** How often a live socket re-announces itself, in ms. `0` disables it. Default 15s. */
  readonly heartbeatMs?: number;
  /** Where a failure nobody awaits is reported. Defaults to `console.error`. */
  readonly onError?: (error: unknown) => void;
  /**
   * A channel's catch-up read, re-run on `replay-gap` or a new epoch: the named query, through
   * core's transport, so its records land in the store. `page-socket.ts` supplies the real one.
   */
  readonly catchUp: (query: string, params: Readonly<Record<string, string>>) => Promise<unknown>;
}
