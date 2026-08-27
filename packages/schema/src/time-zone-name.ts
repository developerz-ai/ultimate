// Single responsibility: is a string an IANA zone NAME? TIER 0'S ONE STATEMENT of the rule
// `@ultimat3/time` enforces everywhere above it — a zone is `Area/Location`, and `UTC` is the one
// exception. `@ultimat3/core` imported its own copy of this predicate until 2026-08-27 and now
// re-exports this one, over the declared `core -> schema` edge.
//
// `@ultimat3/time`'s `canonicalTimeZone` is NOT a fourth copy and is deliberately left alone: it
// answers a different question (the canonical SPELLING, memoised over ~445 listed zones plus a
// probe cache) and shares only the leading-sign rule below. Collapsing it into this predicate
// would trade a cache a request header can hit for one it cannot.

/**
 * A LEADING sign is a fixed offset, which carries no DST rules. `Etc/GMT+2` keeps its `+`.
 *
 * Unobservable on ICU 78 — `+01:00` resolves to itself, so the slash rule below already refuses it,
 * and deleting this line changes no answer this package can currently produce. It stays because it
 * guards the runtime that folds an offset into `Etc/GMT-1`, which WOULD carry a slash, and because
 * `packages/core/src/time-zone-name.ts` and `packages/time/src/zone-canonical.ts` both carry the
 * same line: three statements of one rule may not differ, least of all in the half that is hard to
 * test.
 */
const NUMERIC_OFFSET = /^[+-]/;

/**
 * Structural, and never delegated to `Intl` — the reasoning, and why a denylist is not the
 * alternative, is `packages/time/src/zone-canonical.ts`'s and is not re-derived here. What this
 * file enforces is that same rule at the EDGE: an identifier is `Area/Location`, `UTC` is the one
 * legal exception, and a leading sign is an offset rather than a name.
 *
 * `@ultimat3/core` re-exports THIS function for `app.config.ts`, so the edge validator and the
 * config validator are one predicate. They were two, held equal by a 123-line pin test in
 * `@ultimat3/cli` that no rule required to exist.
 *
 * Of the three copies this is the one that guards CALLER input: `t.timezone` is a request body
 * field and a query parameter through `coerceQuery`, so the bare `new Intl.DateTimeFormat(…)`
 * probe this replaced accepted `+01:00`, `CET` and `Japan` off the wire — since before 6.0.0 for
 * the offset, which ES2024 `Intl` has always resolved — and handed them to a `format` call that
 * answers `X_TIMEZONE_INVALID` three layers later.
 *
 * The judgement is made on the RESOLVED name, not the input, so a casing (`utc`) and a runtime that
 * folds an alias into its target (`Etc/UTC` → `UTC`) both answer correctly. No cache here: a zone
 * arriving from a caller is bounded and canonicalized by `@ultimat3/time`'s `canonicalTimeZone`,
 * which is where a per-process memo belongs — a `Map` keyed on an unvalidated request value is the
 * unbounded growth `@ultimat3/core`'s `intl-cache.ts` exists to prevent.
 */
export function isIanaZoneName(value: string): boolean {
  if (value === '' || NUMERIC_OFFSET.test(value)) return false;
  try {
    const resolved = new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions()
      .timeZone;
    return resolved === 'UTC' || resolved.includes('/');
  } catch {
    return false;
  }
}
