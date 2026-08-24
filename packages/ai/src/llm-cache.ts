/**
 * The semantic cache half of `llm()`: what a declaration may partition on, and the store one
 * declaration reaches. Split from `llm.ts` so that file stays the model call itself.
 *
 * A scope is a separate cache INSTANCE, never a filter over a shared one, and the instance key
 * carries the prompt VERSION as well — which is what makes "editing a prompt requires a version
 * bump" invalidate the cache: a bumped version reaches a different store, so an old answer cannot
 * survive a prompt edit no matter how similar the text.
 *
 * It carries the request LOCALE for the same structural reason, `As of 2026-08-24`. A prompt that
 * takes `locale` as a var — the reference app's `summarize` does, and the model obeys it — differs
 * by one token between languages while carrying a whole document, so the two renderings are
 * neighbours: measured with this package's own `HashEmbedder` over that template, **0.9986**
 * against a declared threshold of `0.97`. The Spanish answer was therefore a hit for an English
 * reader. No threshold fixes it, because the same number has to keep an honest repeat above it.
 */

import type { Ctx } from '@ultimat3/core';
import { parseDuration } from '@ultimat3/time';
import { embedOne, fnv1a } from './embeddings';
import { aiEmbedder, semanticCacheFor } from './runtime';

/** What a `scope` may decide from. The same pair `vars()` receives, and for the same reason. */
export interface LlmScopeArgs<TParsed> {
  readonly input: TParsed;
  readonly ctx: Ctx;
}

export interface LlmSemanticCache<TParsed> {
  /** Cosine floor. Below ~0.9 unrelated prompts collide and the cache answers the wrong one. */
  readonly threshold?: number;
  /** Entry lifetime as a duration string — `'7d'`, `'12h'`. `@ultimat3/time` owns the grammar. */
  readonly ttl?: string;
  /**
   * Partition key. Each scope is a separate cache instance, never a filter over a shared one:
   * cosine similarity has no notion of a tenant, so a shared cache answers one tenant with
   * another's data — by construction, since `lookup` is a nearest neighbour with no predicate.
   *
   * **Omitting it is safe.** The default is the narrowest key the ctx can supply — the actor,
   * its kind and its org — which is `@ultimat3/query`'s `readAuthority` rule applied here: a
   * declaration that says nothing gets the narrowest partition, which is always correct, and
   * WIDENING is a written statement about what the answers are. It defaulted to `'global'`, so a
   * `cache: { semantic: { ttl: '1h' } }` put every tenant in one store.
   *
   * **Breaking: it receives `{ input, ctx }`, not the bare `input`.** Taking `input` alone meant
   * the partition could only be chosen from a value the caller sends, which is the one thing a
   * partition may never be chosen by. `vars()` on the same declaration already takes the pair.
   */
  readonly scope?: (args: LlmScopeArgs<TParsed>) => string;
}

export interface LlmCache<TParsed> {
  readonly semantic: LlmSemanticCache<TParsed>;
  // `05-caching.md` also declares `invalidates: [tag.post]` here. It is deliberately absent
  // until `@ultimat3/cache`'s fan-out can reach something that is not a `CacheTier`: storing
  // tags that the ONE invalidation path never visits would read as wired and silently not be.
  // Today the invalidation story is the prompt version (a bump reaches a different store) and
  // `ttl`.
}

export interface PromptCache {
  lookup(): Promise<unknown>;
  remember(value: unknown): Promise<void>;
}

/**
 * The partition a declaration that named none gets: the narrowest key this call can prove, which
 * is the actor itself. Verbatim the shape `@ultimat3/query`'s `actorAuthority` builds, for the
 * same reason it is JSON rather than a joined string — an actor id is app data and may carry any
 * separator, and a value that can spell a boundary can spell somebody else's.
 *
 * The locale is deliberately NOT here. This function is the DEFAULT a declaration replaces by
 * writing its own `scope`, and the locale has to survive that — so it lives in the unconditional
 * half of the store key, beside the prompt hash.
 *
 * `ctx.actor` is never absent (`createContext` defaults it to `anonymousActor()`), so every
 * anonymous caller shares one partition — which is what the anonymous actor already means
 * everywhere else in the framework.
 */
function actorScope(ctx: Ctx): string {
  return JSON.stringify([ctx.actor.kind, ctx.actor.id, ctx.actor.orgId ?? null]);
}

/**
 * The semantic cache for one declaration, or `undefined` when none was declared. The instance
 * is partitioned by prompt VERSION as well as scope, which is what makes "editing a prompt
 * requires a version bump" invalidate the cache: a bumped version reaches a different store,
 * so an old answer cannot survive a prompt edit no matter how similar the text.
 */
export interface OpenCacheArgs<TParsed> {
  readonly cache: LlmCache<TParsed> | undefined;
  /** Identity and content hash of the prompt artifact — the version half of the partition. */
  readonly prompt: { readonly ref: string; readonly hash: string };
  readonly input: TParsed;
  readonly ctx: Ctx;
  /** The rendered, redacted prompt text: what is embedded and what the entry is keyed on. */
  readonly rendered: string;
}

export async function openCache<TParsed>(
  args: OpenCacheArgs<TParsed>,
): Promise<PromptCache | undefined> {
  const semantic = args.cache?.semantic;
  if (semantic === undefined) return undefined;
  const scope = semantic.scope?.({ input: args.input, ctx: args.ctx }) ?? actorScope(args.ctx);
  // The locale sits with the prompt HASH and not with the scope, on purpose: a scope answers "who
  // may share this answer" and the locale is part of what the answer IS — so a written-down
  // `scope: () => 'global'` is still partitioned by it. An app declaring a shared store is saying
  // its callers may read one another's summaries, never that a Spanish one will do for an English
  // reader. `@ultimat3/render`'s ISR keys by locale for exactly this reason.
  const store = semanticCacheFor(
    `${args.prompt.ref}#${args.prompt.hash}@${args.ctx.locale}::${scope}`,
  );
  const embedding = Array.from(await embedOne(aiEmbedder(), args.rendered));
  const ttlMs = semantic.ttl === undefined ? undefined : parseDuration(semantic.ttl);
  return {
    async lookup(): Promise<unknown> {
      return (await store.lookup(embedding, semantic.threshold))?.value;
    },
    remember(value: unknown): Promise<void> {
      return store.remember(
        `${args.prompt.hash}:${fnv1a(args.rendered).toString(16)}`,
        embedding,
        value,
        ttlMs === undefined ? {} : { ttlMs },
      );
    },
  };
}
