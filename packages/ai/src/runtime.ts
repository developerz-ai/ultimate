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
  /**
   * The last thing that runs over a prompt before it leaves the process. Declared here, in the
   * one place the framework already owns, because `vars()` is the one declared place a model call
   * loads data — the framework knows exactly where the row enters the prompt, and until now
   * nothing sat between that and a third-party endpoint.
   *
   * WHAT to remove is the app's decision, not the framework's: a PII classifier is a model choice
   * and ships in no framework (axiom 8). Ultimate ships the seam, the span attribute
   * (`llm.redacted`) and the one rule it can enforce structurally — a `Secret` reaching `vars()`
   * is `X_AI_PROMPT_SECRET`, whether or not a redactor is installed.
   */
  readonly redact?: Redactor;
}

/**
 * Rewrites a prompt on its way to the provider. Sees the whole RENDERED text, system prompt
 * included — template as well as values, because a redactor shown only the values cannot tell
 * a name in a data slot from the same name in an instruction.
 */
export type Redactor = (text: string) => string;

/** No app redactor installed. Named rather than inline so `llm.redacted` has one thing to mean. */
const noRedaction: Redactor = (text) => text;

interface AiRuntime {
  readonly gateway: Gateway;
  readonly embedder: Embedder;
  readonly semanticCache: (scope: string) => SemanticCache;
  readonly redact: Redactor;
}

let runtime: AiRuntime | undefined;
const caches = new Map<string, SemanticCache>();

export function configureAi(input: AiRuntimeInput): void {
  runtime = {
    gateway: input.gateway,
    embedder: input.embedder ?? new HashEmbedder(),
    semanticCache: input.semanticCache ?? (() => createMemorySemanticCache()),
    redact: input.redact ?? noRedaction,
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

/** The installed redactor, or the identity. Never absent, so the call site has no branch. */
export function aiRedactor(): Redactor {
  return runtime?.redact ?? noRedaction;
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
