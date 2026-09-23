// A client write, the one way: the mutator's optimistic twin into the store's OVERLAY (visible to
// every island before this returns), then its action over HTTP through core's one transport with
// an idempotency key. The answer's records are adopted before the overlay goes — no flicker — and
// a refusal takes the overlay back. The socket carries no writes.

import type { ConflictPolicy } from '@ultimat3/core/page';
import {
  actionPath,
  clientTransport,
  isSuperseded,
  isUltimateError,
  uuid,
} from '@ultimat3/core/page';
import type { JsonValue } from './json';
import { type OutboxHandle, peekOutbox } from './outbox-slot';
import { ServerRenderLiveError } from './page-errors';
import { type PageWrites, pageRealtime } from './page-store';
import { isServerRender, signalFor } from './reactivity';
import { carriedBy } from './record-store';

/**
 * What a hook needs from a mutator, and nothing a server holds: the name its action is routed
 * under, the optimistic twin, and the conflict policy. An island declares this beside its
 * component — the `mutator()` VALUE drags its server half into the bundle.
 *
 * `local` is declared with **method syntax** on purpose: TypeScript relates method parameters
 * bivariantly, so a twin typed over its own `tx` and parsed input assigns here with no cast.
 */
export interface MutatorLike {
  readonly name: string;
  /** Pure: no I/O, no clock, no randomness — it is REPLAYED over every server update. */
  local?(tx: unknown, input: unknown): void;
  /** `@ultimat3/core`'s one row-shaped vocabulary. Default `server-wins`. */
  readonly conflict?: ConflictPolicy;
}

/**
 * A callable mutator with its own in-flight count attached. Resolves with the action's output — or
 * with `undefined` when the network took nothing and the write went to the outbox, overlay kept.
 */
export type Mutate = ((input: JsonValue) => Promise<unknown>) & {
  /** Calls of this mutator the server has not answered yet. */
  readonly pending: number;
  /** Stop counting for this hook (Solid: `onCleanup`). A call already made still settles. */
  release(): void;
  [Symbol.dispose](): void;
};

export interface MutationQueue extends Disposable {
  /** Optimistic writes the server has not answered yet, across every mutator on the page. */
  readonly pending: number;
  /** Writes the server refused since the page loaded. */
  readonly failed: number;
  /** Stop listening (Solid: `onCleanup`) — a page-wide listener outlives any one component. */
  release(): void;
}

/** How a transport failure failed (`meta.failure`), or `undefined` for any other error. */
function transportFailure(error: unknown): unknown {
  if (!isUltimateError(error) || error.code !== 'X_CLIENT_TRANSPORT_FAILED') return undefined;
  return error.meta?.['failure'];
}

function notify(writes: PageWrites): void {
  for (const listener of writes.listeners) listener();
}

function count(writes: PageWrites, name: string, delta: number): void {
  const next = (writes.pending.get(name) ?? 0) + delta;
  if (next > 0) writes.pending.set(name, next);
  else writes.pending.delete(name);
  notify(writes);
}

/**
 * One version signal over the page's write counts, per hook: that bundle's reactive handle, plus
 * the release that takes its listener off the page — the counts outlive every component.
 */
function watch(hook: string, writes: PageWrites | undefined): [() => number, () => void] {
  const [version, setVersion] = signalFor(hook)(0);
  const listener = (): void => setVersion(version() + 1);
  writes?.listeners.add(listener);
  return [version, () => writes?.listeners.delete(listener)];
}

/**
 * After a reload the outbox still holds the writes the network refused, but the store holds only
 * synced truth — the persister never writes an overlay. So the first `useMutation` of a mutator on
 * the page re-applies its twin for each of those writes, in queue order, as the overlay keyed to
 * that write's idempotency key: a replay then settles or rolls it back exactly as a live write.
 */
function restoreOverlays(mutator: MutatorLike): void {
  const local = mutator.local;
  if (local === undefined) return;
  const page = pageRealtime();
  // The boot opens the outbox; after it, so a queue the previous load left is on disk to read.
  void page.booted.then(async () => {
    const outbox = peekOutbox();
    if (outbox === undefined) return;
    await outbox.ready;
    const store = page.store;
    const shown = new Set(store.pending());
    for (const entry of outbox.pending()) {
      if (entry.name !== mutator.name || shown.has(entry.key)) continue;
      store.push(
        entry.key,
        (tx) => mutator.local?.(tx, entry.input),
        mutator.conflict ?? 'server-wins',
      );
    }
  });
}

/** The page's outbox once the boot has finished opening it; `undefined` on a page with no boot. */
async function bootedOutbox(page: {
  readonly booted: Promise<void>;
}): Promise<OutboxHandle | undefined> {
  await page.booted;
  return peekOutbox();
}

export function useMutation(mutator: MutatorLike): Mutate {
  const server = isServerRender();
  const writes = server ? undefined : pageRealtime().writes;
  if (!server) restoreOverlays(mutator);
  const [version, release] = watch('useMutation', writes);
  const call = async (input: JsonValue): Promise<unknown> => {
    if (writes === undefined) throw new ServerRenderLiveError({ operation: 'useMutation()' });
    const page = pageRealtime();
    const key = `${mutator.name}:${uuid()}`;
    const local = mutator.local;
    // Called back through the mutator: `local` may be a method, and an unbound one loses `this`.
    if (local !== undefined) {
      page.store.push(key, (tx) => mutator.local?.(tx, input), mutator.conflict ?? 'server-wins');
    }
    count(writes, mutator.name, 1);
    let output: unknown;
    /** The records the answer carried, `type:key` — what the overlay may be settled against. */
    const carried = new Set<string>();
    try {
      output = await clientTransport({
        method: 'POST',
        url: actionPath(mutator.name),
        body: input,
        idempotencyKey: key,
        onEnvelope: (envelope) => carriedBy(envelope, carried),
      });
    } catch (error) {
      const failure = transportFailure(error);
      // No response at all: the write is the outbox's now, under the SAME idempotency key, and its
      // overlay stays on screen until the replay settles or refuses it. Only a page the boot opened
      // an outbox on can promise that; with none (no boot, so nothing on this page persists) the
      // write is refused like any other, never held in a memory queue a reload would silently lose.
      const outbox = failure === 'network' ? await bootedOutbox(page) : undefined;
      if (outbox !== undefined) {
        await outbox.enqueue({ key, name: mutator.name, input });
        return undefined;
      }
      if (failure === 'body') {
        // A 2xx whose body was not JSON: the write may well have landed, so it is neither queued
        // (a replay would be a second attempt) nor taken back — its overlay waits for the next
        // server row it touched. The caller is still told: nothing here can confirm it.
        page.store.awaitServer(key);
        writes.failed += 1;
        throw error;
      }
      page.store.drop(key);
      // A write superseded by a principal change DID land; it is the previous principal's, and
      // nothing about it is this page's failure to report.
      if (!isSuperseded(error)) writes.failed += 1;
      throw error;
    } finally {
      count(writes, mutator.name, -1);
    }
    try {
      // A row the answer did not carry keeps its overlay until the server's row reaches it.
      page.store.settle(key, carried);
    } catch (error) {
      // A custom merge that answered no row: the server's truth stands, and the caller is told.
      page.store.drop(key);
      throw error;
    }
    return output;
  };
  Object.defineProperty(call, 'pending', {
    get: (): number => {
      version();
      return writes?.pending.get(mutator.name) ?? 0;
    },
  });
  Object.assign(call, { release, [Symbol.dispose]: release });
  // `defineProperty` cannot widen a function type, so the assembled shape is asserted once, here.
  return call as Mutate;
}

/** Every write on the page, as two counts. Zero on a server render, where nothing is written. */
export function useMutationQueue(): MutationQueue {
  const writes = isServerRender() ? undefined : pageRealtime().writes;
  const [version, release] = watch('useMutationQueue', writes);
  return {
    release,
    [Symbol.dispose]: release,
    get pending() {
      version();
      let total = 0;
      for (const n of writes?.pending.values() ?? []) total += n;
      return total;
    },
    get failed() {
      version();
      return writes?.failed ?? 0;
    },
  };
}
