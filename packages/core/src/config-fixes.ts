// Single responsibility: the remedies `app.config.ts`'s validator appends to X_CONFIG_INVALID. Split
// from `config.ts` so the validator stays under its line ceiling; each string is carried only when
// its own key is what failed.

export const BASE_FIX = 'edit app.config.ts to fix the fields named in cause, then run: x verify';

/**
 * Appended only when a tier name is what failed, and it names the rename rather than the rule: the
 * three refused spellings are the ones 8.0.0 accepted, and two of them have a mechanical
 * replacement while `isr` has none — it is a `RenderMode`, and no cache tier ever served it.
 */
export const CACHE_TIER_FIX =
  "in app.config.ts, rewrite cache.tiers with the rung names the ladder serves — request-memo, lru, redis, cdn — where memo becomes request-memo and shared becomes redis, and isr is dropped: it is a render mode, so move it to render: 'isr' on the routes that want it";
