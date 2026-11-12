// The one per-request store behind `memoTier` and `memoPerRequest`: a Map per ALS ctx (WeakMap,
// so it dies with the ctx) under a byte bound. The bound is why this is one file: a job's ctx is
// the whole attempt, and an unbounded memo held every page a backfill ever read until it ended.

import type { Ctx } from '@ultimat3/core';
import { useContext } from '@ultimat3/core';
import { approxBytes } from './approx-bytes';
import { utf8ByteLength } from './byte-length';
import type { CacheTag } from './tags';

/**
 * 8 MiB per ctx. A request never comes near it; a job attempt reading page after page does, and
 * the memo is best-effort — an evicted entry is one more read, never a wrong one — so the oldest
 * goes, silently.
 */
export const MEMO_MAX_BYTES = 8 * 1024 * 1024;

/**
 * A `memoTier` entry: codec text, as in every other tier — two callers in one request reading one
 * key must not share one mutable object, and a hit here must be the shape the LRU or Redis would
 * have answered.
 */
export interface MemoTextEntry {
  readonly kind: 'text';
  readonly text: string;
  readonly tags: readonly CacheTag[];
  bytes: number;
}

/** A `memoPerRequest` entry: the function's own return value — a promise is the read in flight. */
export interface MemoValueEntry {
  readonly kind: 'value';
  readonly value: unknown;
  bytes: number;
}

export type MemoEntry = MemoTextEntry | MemoValueEntry;

/** Insertion order is age: `Map` iterates oldest first, so the eviction needs no list. */
export interface MemoStore {
  readonly entries: Map<string, MemoEntry>;
  bytes: number;
}

const stores = new WeakMap<object, MemoStore>();

export function currentCtx(): object | undefined {
  try {
    const ctx: Ctx = useContext();
    return typeof ctx === 'object' && ctx !== null ? (ctx as object) : undefined;
  } catch {
    // No ambient context: not a request. Nothing to memoize against.
    return undefined;
  }
}

export function storeFor(create: boolean): MemoStore | undefined {
  const ctx = currentCtx();
  return ctx === undefined ? undefined : storeOf(ctx, create);
}

/** The store of an EXPLICIT ctx — `@ultimat3/query` is handed its ctx rather than reading ALS. */
export function storeOf(ctx: object, create: true): MemoStore;
export function storeOf(ctx: object, create: boolean): MemoStore | undefined;
export function storeOf(ctx: object, create: boolean): MemoStore | undefined {
  const existing = stores.get(ctx);
  if (existing !== undefined) return existing;
  if (!create) return undefined;
  const fresh: MemoStore = { entries: new Map(), bytes: 0 };
  stores.set(ctx, fresh);
  return fresh;
}

export function dropStore(): void {
  const ctx = currentCtx();
  if (ctx !== undefined) stores.delete(ctx);
}

/**
 * What an entry costs: its key plus its text, or its value from a bounded sample (`approxBytes`) —
 * a held value is charged on every query read, so it is never serialised to be measured.
 */
export function entryBytes(key: string, entry: MemoEntry): number {
  const body = entry.kind === 'text' ? utf8ByteLength(entry.text) : approxBytes(entry.value);
  return utf8ByteLength(key) + body;
}

export function removeEntry(store: MemoStore, key: string): void {
  const entry = store.entries.get(key);
  if (entry === undefined) return;
  store.entries.delete(key);
  store.bytes -= entry.bytes;
}

/**
 * Re-price a held entry at `bytes` (a write, or an async value settling), then evict oldest-first
 * to the bound. An entry over the bound on its own is dropped instead, evicting nothing.
 */
export function charge(store: MemoStore, key: string, entry: MemoEntry, bytes: number): void {
  if (store.entries.get(key) !== entry) return;
  if (bytes > MEMO_MAX_BYTES) {
    removeEntry(store, key);
    return;
  }
  store.bytes += bytes - entry.bytes;
  entry.bytes = bytes;
  for (const [oldest] of store.entries) {
    if (store.bytes <= MEMO_MAX_BYTES) break;
    if (oldest !== key) removeEntry(store, oldest);
  }
}

/**
 * Store as the NEWEST entry. An entry over the bound on its own is not memoized and evicts nothing:
 * clearing the whole store to hold one value it cannot hold would cost every other read.
 */
export function putEntry(store: MemoStore, key: string, entry: MemoEntry): void {
  removeEntry(store, key);
  entry.bytes = 0;
  store.entries.set(key, entry);
  charge(store, key, entry, entryBytes(key, entry));
}

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    (typeof value === 'object' || typeof value === 'function') &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === 'function'
  );
}

/**
 * Hold a function's own return value as the NEWEST entry. A promise is the read in flight: charged
 * at what it settles to (pending, it measures as `{}`), and dropped if it rejects — a rejection is
 * not an answer. Both are no-ops once the entry was evicted or replaced in the meantime, so a
 * later write is never undone by an earlier read settling.
 *
 * A pending entry is NOT pinned against eviction: evicting one costs the next reader a second read
 * of the same source, never a wrong answer, and a pin would let N pending reads hold the bound open.
 */
export function holdValue(store: MemoStore, slot: string, value: unknown): void {
  const entry: MemoValueEntry = { kind: 'value', value, bytes: 0 };
  putEntry(store, slot, entry);
  if (!isThenable(value)) return;
  // Neither handler may throw: a throw in either is an unhandled rejection of the promise
  // `.then` returns, which nobody awaits. `approxBytes` cannot throw; the `try` is the guarantee.
  value.then(
    (settled) => {
      try {
        charge(store, slot, entry, entryBytes(slot, { ...entry, value: settled }));
      } catch {
        // Unmeasurable: it stays held at its pending charge, which is still under the bound.
      }
    },
    () => {
      if (store.entries.get(slot) === entry) removeEntry(store, slot);
    },
  );
}
