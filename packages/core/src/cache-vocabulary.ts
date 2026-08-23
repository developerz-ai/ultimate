// Single responsibility: the one closed vocabulary of cache tiers — the rungs of the read ladder,
// in read order. Tier 0 so `app.config.ts` and `@ultimat3/cache` name the same rungs; the cache
// package owns the LADDER, this module owns only the NAMES, because tier 0 is the one place a
// tier-0 config declaration and a tier-1 implementation can both see.
// Deliberately not `config.ts`: `app.config.ts` CONSUMES these names, it does not own them.

/**
 * The rungs, near to far. **Order is load-bearing**: `sortTiers` in `@ultimat3/cache` orders a
 * stack by index in this array, so a name's position here IS its distance from the request, and a
 * name missing from it sorts to `-1` — ahead of the request memo.
 *
 * Spelled once because it was spelled twice and the two disagreed (issue #293): `app.config.ts`
 * accepted `memo | lru | shared | isr | cdn` while the stack ordered `request-memo | lru | redis |
 * cdn`, so `cache: { tiers: ['isr'] }` typechecked and selected nothing. `memo`/`request-memo` and
 * `shared`/`redis` were one rung spelled twice; the ladder's spelling wins, because it is the one
 * a `TierInvalidation`, a `TierFailure` and the `/_x` panel already report.
 *
 * **`isr` is not here and is not a cache tier.** It is a `RenderMode` (`route-vocabulary.ts`) — a
 * per-route rendering decision, revalidated by a tag bust — and `@ultimat3/cache` has no ISR store
 * to build: `'isr'` appears nowhere in `packages/cache/src` except one invalidation label. Serving
 * ISR is `render: 'isr'` on the route, never a rung of this ladder.
 */
export const CACHE_TIERS = ['request-memo', 'lru', 'redis', 'cdn'] as const;

/** Derived from the array rather than written twice, so the pair cannot disagree. */
export type CacheTierName = (typeof CACHE_TIERS)[number];
