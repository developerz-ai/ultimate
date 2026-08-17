// Tier 1: in-process LRU bounded by BYTES, not entry count — an entry count budget is a
// memory leak with extra steps once payload sizes vary. Doubly-linked list + Map for O(1)
// touch/evict, plus a tag -> keys index so `invalidateTags` never scans the whole cache.
// Zero dependencies: this must work in the `x dev` process with nothing installed.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import { CacheTooLargeError } from './errors';
import type { CacheTag } from './tags';
import { serializeTag } from './tags';
import type {
  CacheEntry,
  CacheSetOptions,
  CacheTier,
  Rng,
  TierInvalidation,
  TtlJitter,
} from './tiers';
import { assertTtl, nowMs } from './tiers';

export interface LruOptions {
  /** Byte budget for the whole tier. Default 64 MiB. */
  readonly maxBytes?: number;
  /** Applied when a `set` omits `ttlMs`. Default 60s — stale-by-default is safer here. */
  readonly defaultTtlMs?: number;
  readonly clock?: Clock;
  /** TTL spread, in `[0, 1)`. Default `DEFAULT_TTL_JITTER_FRACTION`; `0` disables it. */
  readonly jitterFraction?: number;
  /** Injected so a jittered expiry is deterministic; `() => 0` is the full lease. */
  readonly rng?: Rng;
}

interface LruNode {
  key: string;
  value: unknown;
  bytes: number;
  /** Epoch ms. Always finite: `assertTtl` refuses the `0` that used to mean "never expires". */
  expiresAt: number;
  tags: readonly CacheTag[];
  prev: LruNode | undefined;
  next: LruNode | undefined;
}

const encoder = new TextEncoder();

/** Cheap, deterministic size estimate. Exact heap cost is unknowable; consistency matters. */
export function estimateBytes(value: unknown): number {
  if (value === undefined) return 0;
  if (typeof value === 'string') return encoder.encode(value).byteLength;
  if (value instanceof ArrayBuffer) return value.byteLength;
  if (ArrayBuffer.isView(value)) return value.byteLength;
  try {
    return encoder.encode(JSON.stringify(value) ?? '').byteLength;
  } catch {
    return 1024;
  }
}

function index(into: Map<string, Set<string>>, bucket: string, key: string): void {
  let set = into.get(bucket);
  if (set === undefined) {
    set = new Set();
    into.set(bucket, set);
  }
  set.add(key);
}

function deindex(from: Map<string, Set<string>>, bucket: string, key: string): void {
  const set = from.get(bucket);
  if (set === undefined) return;
  set.delete(key);
  if (set.size === 0) from.delete(bucket);
}

export interface LruStats {
  readonly entries: number;
  readonly bytes: number;
  readonly maxBytes: number;
  readonly hits: number;
  readonly misses: number;
  readonly evictions: number;
}

export class LruCache {
  private readonly map = new Map<string, LruNode>();
  private readonly tagIndex = new Map<string, Set<string>>();
  private readonly entityIndex = new Map<string, Set<string>>();
  private readonly maxBytes: number;
  private readonly defaultTtlMs: number;
  private readonly clock: Clock;
  private readonly jitter: TtlJitter;
  private head: LruNode | undefined;
  private tail: LruNode | undefined;
  private bytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: LruOptions = {}) {
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    this.defaultTtlMs = options.defaultTtlMs ?? 60_000;
    this.clock = options.clock ?? systemClock;
    this.jitter = {
      ...(options.jitterFraction === undefined ? {} : { jitterFraction: options.jitterFraction }),
      ...(options.rng === undefined ? {} : { rng: options.rng }),
    };
  }

  get<T>(key: string): CacheEntry<T> | undefined {
    const node = this.map.get(key);
    if (node === undefined) {
      this.misses += 1;
      return undefined;
    }
    if (node.expiresAt <= nowMs(this.clock)) {
      this.unlink(node);
      this.misses += 1;
      return undefined;
    }
    this.touch(node);
    this.hits += 1;
    return { value: node.value as T, tags: node.tags, expiresAt: node.expiresAt };
  }

  set<T>(key: string, value: T, options: CacheSetOptions = {}): void {
    const bytes = estimateBytes(value) + encoder.encode(key).byteLength;
    if (bytes > this.maxBytes) {
      throw new CacheTooLargeError({ key, bytes, maxBytes: this.maxBytes, tier: 'lru' });
    }

    // Validate BEFORE evicting the entry being replaced: a rejected write must leave the cache
    // exactly as it found it, or `X_CACHE_TTL_INVALID` also silently drops a live, valid value.
    const ttl = assertTtl(key, options.ttlMs ?? this.defaultTtlMs, 'lru', this.jitter);
    const existing = this.map.get(key);
    if (existing !== undefined) this.unlink(existing);

    const node: LruNode = {
      key,
      value,
      bytes,
      expiresAt: nowMs(this.clock) + ttl,
      tags: options.tags ?? [],
      prev: undefined,
      next: undefined,
    };

    this.map.set(key, node);
    this.bytes += bytes;
    this.pushFront(node);
    for (const owned of node.tags) {
      index(this.tagIndex, serializeTag(owned), key);
      index(this.entityIndex, owned.entity, key);
    }

    while (this.bytes > this.maxBytes && this.tail !== undefined) {
      this.unlink(this.tail);
      this.evictions += 1;
    }
  }

  del(key: string): boolean {
    const node = this.map.get(key);
    if (node === undefined) return false;
    this.unlink(node);
    return true;
  }

  /** Only entries carrying a matching tag are dropped; untagged neighbours survive. */
  invalidateTags(tags: readonly CacheTag[]): readonly string[] {
    const candidates = new Set<string>();
    for (const requested of tags) {
      if (requested.id === undefined) {
        // Collection bust: every row of that entity goes too.
        for (const key of this.entityIndex.get(requested.entity) ?? []) candidates.add(key);
        continue;
      }
      // Row bust: the row itself plus anything tagged with the bare collection.
      for (const key of this.tagIndex.get(serializeTag(requested)) ?? []) candidates.add(key);
      for (const key of this.tagIndex.get(requested.entity) ?? []) candidates.add(key);
    }

    const removed: string[] = [];
    for (const key of candidates) {
      if (this.del(key)) removed.push(key);
    }
    return removed;
  }

  keys(): readonly string[] {
    const out: string[] = [];
    for (let node = this.head; node !== undefined; node = node.next) out.push(node.key);
    return out;
  }

  clear(): void {
    this.map.clear();
    this.tagIndex.clear();
    this.entityIndex.clear();
    this.head = undefined;
    this.tail = undefined;
    this.bytes = 0;
    // Stats describe THIS cache's lifetime, not the process's — a cleared cache is a fresh one,
    // so `stats()` after `clear()` must not still show hits/evictions from what is now gone.
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  stats(): LruStats {
    return {
      entries: this.map.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }

  private pushFront(node: LruNode): void {
    node.prev = undefined;
    node.next = this.head;
    if (this.head !== undefined) this.head.prev = node;
    this.head = node;
    if (this.tail === undefined) this.tail = node;
  }

  private touch(node: LruNode): void {
    if (this.head === node) return;
    this.detach(node);
    this.pushFront(node);
  }

  private detach(node: LruNode): void {
    if (node.prev !== undefined) node.prev.next = node.next;
    else if (this.head === node) this.head = node.next;
    if (node.next !== undefined) node.next.prev = node.prev;
    else if (this.tail === node) this.tail = node.prev;
    node.prev = undefined;
    node.next = undefined;
  }

  private unlink(node: LruNode): void {
    this.detach(node);
    this.map.delete(node.key);
    this.bytes -= node.bytes;
    for (const owned of node.tags) {
      deindex(this.tagIndex, serializeTag(owned), node.key);
      deindex(this.entityIndex, owned.entity, node.key);
    }
  }
}

export function createLruTier(options: LruOptions = {}): CacheTier & { readonly cache: LruCache } {
  const cache = new LruCache(options);
  return {
    name: 'lru',
    cache,
    get<T>(key: string) {
      return Promise.resolve(cache.get<T>(key));
    },
    // `async`, so a refusal is a REJECTION and not a synchronous throw out of a function typed
    // `Promise<void>`. `LruCache.set` stays synchronous — it is a sync API — but a `CacheTier` is
    // one interface with two implementations, and `tier.set(...).catch(...)` has to mean the same
    // thing on the in-process rung as on the shared one, where the throw is already a rejection.
    async set<T>(key: string, value: T, setOptions?: CacheSetOptions) {
      cache.set(key, value, setOptions ?? {});
    },
    del(key: string) {
      cache.del(key);
      return Promise.resolve();
    },
    invalidateTags(tags: readonly CacheTag[]): Promise<TierInvalidation> {
      return Promise.resolve({ tier: 'lru', keys: cache.invalidateTags(tags) });
    },
  };
}
