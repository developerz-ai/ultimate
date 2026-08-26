// The semantic cache for LLM calls: a near-duplicate prompt should not pay for a second
// completion. Keyed by embedding, matched by cosine similarity above a threshold — exact
// string keys miss on "list my orders" vs "show me my orders", which is most of the traffic.
// The in-memory default is correct but O(n); pgvector is the production backing (an ivfflat
// index over `x_semantic_cache.embedding`), which is why the interface is a driver.

import type { Clock } from '@ultimat3/core';
import { systemClock } from '@ultimat3/core';
import type { CacheTag } from './tags';
import { tagsIntersect } from './tags';
import {
  assertFiniteCapacity,
  assertFiniteDurationMs,
  assertFiniteSimilarityFloor,
  assertTtl,
  nowMs,
} from './tiers';

export type Embedding = readonly number[];

export interface SemanticHit<T> {
  readonly value: T;
  readonly similarity: number;
  readonly key: string;
}

export interface SemanticRememberOptions {
  readonly ttlMs?: number;
  readonly tags?: readonly CacheTag[];
}

export interface SemanticCache {
  readonly name: string;
  /** Nearest neighbour above `threshold`, or `undefined`. */
  lookup<T>(embedding: Embedding, threshold?: number): Promise<SemanticHit<T> | undefined>;
  remember<T>(
    key: string,
    embedding: Embedding,
    value: T,
    options?: SemanticRememberOptions,
  ): Promise<void>;
  invalidateTags(tags: readonly CacheTag[]): Promise<readonly string[]>;
  size(): Promise<number>;
}

export interface SemanticCacheOptions {
  /**
   * Default 0.92. Below ~0.9 unrelated prompts start colliding and the cache answers the
   * wrong question — a worse failure than a cache miss, so the default is deliberately tight.
   */
  readonly threshold?: number;
  readonly maxEntries?: number;
  readonly defaultTtlMs?: number;
  readonly clock?: Clock;
}

export function cosineSimilarity(a: Embedding, b: Embedding): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

interface SemanticRecord {
  readonly key: string;
  readonly embedding: Embedding;
  readonly value: unknown;
  readonly expiresAt: number;
  readonly tags: readonly CacheTag[];
}

export function createMemorySemanticCache(options: SemanticCacheOptions = {}): SemanticCache {
  // Screened at construction, both of them: this tier's two knobs are the ones whose failure is
  // silent — a floor of NaN matches everything, a ceiling of NaN evicts nothing.
  const threshold = assertFiniteSimilarityFloor('semantic', 'threshold', options.threshold ?? 0.92);
  const maxEntries = assertFiniteCapacity('semantic', 'maxEntries', options.maxEntries ?? 1000);
  const defaultTtlMs = assertFiniteDurationMs(
    'semantic',
    'defaultTtlMs',
    options.defaultTtlMs ?? 3_600_000,
  );
  const clock = options.clock ?? systemClock;
  const records = new Map<string, SemanticRecord>();

  const live = (): SemanticRecord[] => {
    const at = nowMs(clock);
    const out: SemanticRecord[] = [];
    for (const [key, record] of records) {
      if (record.expiresAt <= at) records.delete(key);
      else out.push(record);
    }
    return out;
  };

  return {
    name: 'memory',

    lookup<T>(embedding: Embedding, override?: number): Promise<SemanticHit<T> | undefined> {
      // The override is the same boundary, arriving per call — screened for the same reason, and
      // this is the one that can carry a value straight off a request.
      const floor =
        override === undefined
          ? threshold
          : assertFiniteSimilarityFloor('semantic', 'threshold', override);
      let best: SemanticHit<T> | undefined;
      for (const record of live()) {
        const similarity = cosineSimilarity(embedding, record.embedding);
        if (similarity < floor) continue;
        if (best === undefined || similarity > best.similarity) {
          best = { value: record.value as T, similarity, key: record.key };
        }
      }
      return Promise.resolve(best);
    },

    remember<T>(
      key: string,
      embedding: Embedding,
      value: T,
      rememberOptions?: SemanticRememberOptions,
    ): Promise<void> {
      // The same TTL rule every tier writes under, and for the same reason: `0` here silently
      // stored an entry that was already expired, so the cache answered every lookup with a miss
      // and nothing said why. `jitterFraction: 0` — spreading a lease is a herd defence for a
      // shared store, and this one is per process.
      const ttlMs = assertTtl(key, rememberOptions?.ttlMs ?? defaultTtlMs, 'semantic', {
        jitterFraction: 0,
      });
      records.delete(key);
      records.set(key, {
        key,
        embedding,
        value,
        expiresAt: nowMs(clock) + ttlMs,
        tags: rememberOptions?.tags ?? [],
      });
      // Insertion-ordered Map: the oldest key is the first one.
      while (records.size > maxEntries) {
        const oldest = records.keys().next();
        if (oldest.done === true) break;
        records.delete(oldest.value);
      }
      return Promise.resolve();
    },

    invalidateTags(tags: readonly CacheTag[]): Promise<readonly string[]> {
      const removed: string[] = [];
      for (const [key, record] of records) {
        if (tagsIntersect(tags, record.tags)) {
          records.delete(key);
          removed.push(key);
        }
      }
      return Promise.resolve(removed);
    },

    size(): Promise<number> {
      return Promise.resolve(live().length);
    },
  };
}
