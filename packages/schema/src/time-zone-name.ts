// Single responsibility: is a string an IANA zone NAME? Tier 0's second statement of the one rule
// `@ultimat3/time` enforces everywhere above it — a zone is `Area/Location`, and `UTC` is the one
// exception. It is stated a third time because `schema` is tier 0 and may import neither
// `@ultimat3/time` nor `@ultimat3/core`; `packages/time/src/zone-canonical.ts` is where the rule
// and its reasoning are written down.

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
 * `@ultimat3/core`'s `isIanaZoneName` is the same predicate for `app.config.ts`. Nothing below
 * tier 5 can compare the two, so `timezone-validator-pin.test.ts` in `@ultimat3/cli` is the
 * mechanical half — the arrangement `schema-error-codes-pin.test.ts` already uses for tier 0's
 * other deliberate duplicate.
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
