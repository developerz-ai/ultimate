// The ambient AI runtime an `llm()` action calls into: the gateway that serves every model
// call, the embedder the semantic cache keys on, and one semantic cache per declared scope.
//
// Ambient rather than injected, for the same reason the budget ledger is: an `llm()`
// declaration is evaluated at module scope, long before a provider, an API key or a request
// exists. Boot installs one runtime, a test installs a fake, and there is no second way for
// an action to reach a provider — which is what keeps budgets and cost accounting
// un-bypassable rather than merely recommended.

import type { SemanticCache } from '@ultimat3/cache';
import { createMemorySemanticCache } from '@ultimat3/cache';
import type { Embedder } from './embeddings';
import { HashEmbedder } from './embeddings';
import { AiGatewayMissingError } from './errors';
import type { Gateway } from './gateway';

export interface AiRuntimeInput {
  readonly gateway: Gateway;
  /**
   * Keys the semantic cache. Defaults to `HashEmbedder`: deterministic, offline, and lexical
   * rather than semantic — at the thresholds an LLM cache runs at that is a near-exact-match
   * cache, which is the safe way to be wrong. Install a real embedder to get paraphrase hits.
   */
  readonly embedder?: Embedder;
  /** One cache per scope key. Defaults to the in-memory driver; pgvector in production. */
  readonly semanticCache?: (scope: string) => SemanticCache;
}

interface AiRuntime {
  readonly gateway: Gateway;
  readonly embedder: Embedder;
  readonly semanticCache: (scope: string) => SemanticCache;
}

let runtime: AiRuntime | undefined;
const caches = new Map<string, SemanticCache>();

export function configureAi(input: AiRuntimeInput): void {
  runtime = {
    gateway: input.gateway,
    embedder: input.embedder ?? new HashEmbedder(),
    semanticCache: input.semanticCache ?? (() => createMemorySemanticCache()),
  };
  // A new runtime means a new embedder and a new gateway; vectors from the old one are not
  // comparable to vectors from the new one, and a stale hit would answer the wrong question.
  caches.clear();
}

/** The installed gateway. `prompt` names the caller so the miss says what was about to run. */
export function aiGateway(prompt: string): Gateway {
  if (runtime === undefined) throw new AiGatewayMissingError({ prompt });
  return runtime.gateway;
}

export function aiEmbedder(): Embedder {
  return runtime?.embedder ?? new HashEmbedder();
}

/**
 * The cache for one scope. Scopes are separate CACHE INSTANCES, never a filter over a shared
 * one: cosine similarity has no notion of a tenant, so two tenants asking near-identical
 * questions of a shared cache is one tenant reading the other's answer. Partitioning is the
 * only thing that makes that structurally impossible.
 */
export function semanticCacheFor(scope: string): SemanticCache {
  const existing = caches.get(scope);
  if (existing !== undefined) return existing;
  const created = runtime?.semanticCache(scope) ?? createMemorySemanticCache();
  caches.set(scope, created);
  return created;
}

/** Test-only reset. Module-level state otherwise leaks between test files. */
export function resetAiRuntime(): void {
  runtime = undefined;
  caches.clear();
}
