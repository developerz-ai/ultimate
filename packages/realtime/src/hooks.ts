// The four calls a component makes: one live query, one connection view, one mutator call, one
// queue view. Nothing here is a reactive runtime — realtime never imports solid-js, so every
// accessor is a closure over the `SignalFactory` the registered `LiveClient` was built with, and
// every hook resolves that client through one ambient seam rather than a context per surface.

import type { LiveClient, LiveHandle, LiveQueryRef, MutatorRef } from './client';
import { LiveClientMissingError } from './errors';
import type { JsonValue, Row } from './json';
import type { LocalTx } from './local-store';
import type { ConflictStrategy } from './rebase';

/** What `setLiveClient` holds. The version signal is the queue's only reactive handle — see below. */
interface Registered {
  readonly client: LiveClient;
  /** Read to subscribe, bumped to invalidate: `OfflineQueue` stores plain arrays, not signals. */
  readonly version: () => number;
  readonly bump: () => void;
}

let registered: Registered | null = null;

/** Register once, in the app entry, before the first render. One app, one socket, one client. */
export function setLiveClient(client: LiveClient): void {
  const [version, setVersion] = client.signal<number>(0);
  const bump = (): void => {
    setVersion(version() + 1);
  };
  registered = { client, version, bump };
  // Closes the gap a direct call can't: a reconnect drains automatically inside `connect()`, and
  // an ack/fail frame arrives asynchronously inside `#onFrame` — neither is awaited by any hook, so
  // this is the only path that reaches them. The direct `bump()` calls below stay too: they fire at
  // the earliest possible moment for the call that made them, and a redundant bump is harmless.
  client.onQueueChange(bump);
}

/** For tests: drop the registration so cases stay independent. */
export function clearLiveClient(): void {
  registered = null;
}

export function hasLiveClient(): boolean {
  return registered !== null;
}

function live(hook: string): Registered {
  if (registered === null) throw new LiveClientMissingError({ hook });
  return registered;
}

// ---- useLive ------------------------------------------------------------------------------------

/** The query's input, or a thunk returning it. The thunk is read once — see `useLive`. */
export type LiveInput = JsonValue | (() => JsonValue);

/**
 * A callable result set: `feed()` are the rows, `feed.state()` / `feed.cursor()` /
 * `feed.unsubscribe()` are the rest of the `LiveHandle` hanging off it.
 *
 * `R` is only constrained to `object`: on the wire every row is a `Row`, but a hook bound to a
 * declared query (`query-hook.ts`) answers in that query's own row type, which is whatever its
 * `sql` returns. The three members hanging off the accessor are the same for every `R`.
 */
export type LiveRows<R extends object = Row> = (() => readonly R[]) & Omit<LiveHandle, 'rows'>;

/**
 * Subscribe to a live query. `query` is anything carrying a `name`, which a `@ultimat3/query`
 * `Query` satisfies structurally — realtime is tier 3, so it names the shape rather than importing
 * the package sideways.
 *
 * A thunk `input` is read **once**, at subscribe time: tier 3 has no reactive runtime of its own,
 * so nothing re-runs it when its dependencies change. Changing input means a new subscription.
 * The caller owns `unsubscribe` — nothing here disposes on unmount, because nothing here knows
 * what a mount is.
 */
export function useLive<R extends Row = Row>(query: LiveQueryRef, input: LiveInput): LiveRows<R> {
  const handle = live('useLive').client.useLive<R>(
    query,
    typeof input === 'function' ? input() : input,
  );
  return Object.assign((): readonly R[] => handle.rows(), {
    state: handle.state,
    cursor: handle.cursor,
    unsubscribe: handle.unsubscribe,
  });
}

// ---- useConnection ------------------------------------------------------------------------------

export interface Connection {
  readonly offline: boolean;
  readonly online: boolean;
  /** Epoch ms of the next reconnect attempt; `null` while the socket is up. */
  readonly reconnectAt: number | null;
  /** The buildId the server announced, or `null` while this build is current. */
  readonly updateAvailable: string | null;
}

/**
 * The socket, as four booleans and two values. Every member is a **getter**, so a read inside a
 * tracking scope reaches the underlying signal; a snapshot object would freeze the answer at the
 * moment the component rendered and never say "offline" again.
 */
export function useConnection(): Connection {
  const client = live('useConnection').client;
  return {
    get offline() {
      return !client.connected;
    },
    get online() {
      return client.connected;
    },
    get reconnectAt() {
      return client.reconnectAt();
    },
    get updateAvailable() {
      return client.appUpdateAvailable();
    },
  };
}

// ---- useMutation --------------------------------------------------------------------------------

/**
 * Both spellings of a conflict strategy: realtime's `custom()` (`{ kind: 'custom' }`, merging rows)
 * and `@ultimat3/action`'s (`{ strategy: 'custom' }`, merging parsed outputs).
 */
export type ConflictLike = ConflictStrategy | { readonly strategy: 'custom' };

/**
 * What a hook needs from a mutator: the name it queues under, and the optimistic twin. A
 * `@ultimat3/action` `Mutator` satisfies it structurally.
 *
 * `local` is declared with **method syntax** on purpose. TypeScript relates method parameters
 * bivariantly, so a `Mutator` whose `local` takes its own parsed input and its own `tx` assigns
 * here with no cast at the call site; written as a function-typed property, `strictFunctionTypes`
 * would reject exactly that mutator. The parameters are `unknown` because this layer never reads
 * them — it binds them and hands the closure to the client.
 */
export interface MutatorLike {
  readonly name: string;
  local?(tx: unknown, input: unknown): void;
  readonly entity?: string;
  readonly conflict?: ConflictLike;
}

/** A callable mutator with its own queue depth attached. */
export type Mutate = ((input: JsonValue) => Promise<void>) & {
  /** Queued mutations of this mutator. Always `0` at tier 2, where nothing is queued. */
  readonly pending: number;
};

/**
 * Call a mutator: optimistic twin, rebase entry, durable queue, drain — all of it inside
 * `LiveClient.mutate`. `pending` is a getter, so it stays reactive for as long as the component
 * reads it; it refreshes on every call routed through this hook and on `useMutationQueue().drain`.
 */
export function useMutation(mutator: MutatorLike): Mutate {
  const state = live('useMutation');
  const ref = mutatorRef(mutator);
  const call = async (input: JsonValue): Promise<void> => {
    await state.client.mutate(ref, input);
    state.bump();
  };
  Object.defineProperty(call, 'pending', {
    get: (): number => {
      state.version();
      const queue = state.client.queue;
      return queue === undefined
        ? 0
        : queue.pending().filter((mutation) => mutation.name === mutator.name).length;
    },
  });
  // `defineProperty` cannot widen a function type, so the assembled shape is asserted once, here.
  return call as Mutate;
}

// ---- useMutationQueue ---------------------------------------------------------------------------

export interface MutationQueue {
  /** Queued and not yet acknowledged, across every mutator. */
  readonly pending: number;
  /** Terminally failed — a policy denial or a validation error, kept for the UI, never retried. */
  readonly failed: number;
  drain(): Promise<void>;
}

/** The whole durable queue, as two counts and the one command that empties it. */
export function useMutationQueue(): MutationQueue {
  const state = live('useMutationQueue');
  return {
    get pending() {
      state.version();
      return state.client.queue?.pending().length ?? 0;
    },
    get failed() {
      state.version();
      const all = state.client.queue?.all() ?? [];
      return all.filter((mutation) => mutation.status === 'failed').length;
    },
    drain: async () => {
      await state.client.drain();
      state.bump();
    },
  };
}

/** The hook's mutator, as the client's. Only the twin needs binding; the rest is carried through. */
function mutatorRef(mutator: MutatorLike): MutatorRef {
  const conflict = replayable(mutator.conflict);
  return {
    name: mutator.name,
    // Called back through the mutator rather than through a hoisted reference: `local` may be
    // written as a method, and an unbound method loses the receiver its body could read.
    ...(mutator.local === undefined
      ? {}
      : {
          local: (tx: LocalTx, input: JsonValue) => {
            mutator.local?.(tx, input);
          },
        }),
    ...(mutator.entity === undefined ? {} : { entity: mutator.entity }),
    ...(conflict === undefined ? {} : { conflict }),
  };
}

/**
 * `@ultimat3/action`'s `custom(merge)` merges parsed *outputs*; realtime's merges *rows*. Only the
 * second is a `CustomMerge` `reconcile` can replay, so the other spelling is dropped rather than
 * handed to a rebase that would call it with the wrong argument — the log then takes its default.
 */
function replayable(conflict: ConflictLike | undefined): ConflictStrategy | undefined {
  if (conflict === undefined || typeof conflict === 'string') return conflict;
  return 'kind' in conflict ? conflict : undefined;
}
