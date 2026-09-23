// Single responsibility: the remedies `app.config.ts`'s validator appends to X_CONFIG_INVALID. Split
// from `config.ts` so the validator stays under its line ceiling; each string is carried only when
// its own key is what failed.

export const BASE_FIX = 'edit app.config.ts to fix the fields named in cause, then run: x verify';

/**
 * Appended only when the zone is what failed. Axiom 4: an operator holding `'CET'` needs the
 * spelling to write, and the two refused classes have different remedies — a single-label legacy
 * name swaps mechanically, an abbreviation or an offset has no replacement at all because it names
 * no jurisdiction. Deliberately parallel to `@ultimat3/time`'s `X_TIMEZONE_INVALID` fix, since the
 * two refuse the same strings and an operator may meet either first.
 */
export const TIMEZONE_FIX =
  "set defaultTimeZone to an Area/Location name, or UTC — list every accepted one with bun -e \"console.log(Intl.supportedValuesOf('timeZone').join('\\n'))\" — where a legacy single-label name swaps mechanically (Japan → Asia/Tokyo, GB → Europe/London, Universal → UTC), while an abbreviation or numeric offset (CET, EST5EDT, +01:00) carries no DST rule and has no replacement, so name the city whose clock you mean (Europe/Paris, America/New_York)";

/**
 * Appended only when a tier name is what failed, and it names the rename rather than the rule: the
 * three refused spellings are the ones 8.0.0 accepted, and two of them have a mechanical
 * replacement while `isr` has none — it is a `RenderMode`, and no cache tier ever served it.
 */
export const CACHE_TIER_FIX =
  "in app.config.ts, rewrite cache.tiers with the rung names the ladder serves — request-memo, lru, redis, cdn — where memo becomes request-memo and shared becomes redis, and isr is dropped: it is a render mode, so move it to render: 'isr' on the routes that want it";
