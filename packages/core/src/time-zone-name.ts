// Single responsibility: is a string an IANA zone NAME? Tier 0's statement of the one rule
// `@ultimat3/time` enforces everywhere above it — a zone is `Area/Location`, and `UTC` is the one
// exception. It is stated twice because `core` is tier 0 and may not import `@ultimat3/time`;
// `packages/time/src/zone-canonical.ts` is where the rule and its reasoning are written down.

/**
 * A LEADING sign is a fixed offset, which carries no DST rules. `Etc/GMT+2` keeps its `+`.
 *
 * Unobservable on ICU 78 — `+01:00` resolves to itself, so the slash rule below already refuses it,
 * and deleting this line changes no answer this package can currently produce. It stays because it
 * guards the runtime that folds an offset into `Etc/GMT-1`, which WOULD carry a slash, and because
 * `packages/time/src/zone-canonical.ts` carries the same line: two statements of one rule may not
 * differ, least of all in the half that is hard to test.
 */
const NUMERIC_OFFSET = /^[+-]/;

/**
 * Structural, and never delegated to `Intl` — the reasoning, and why a denylist is not the
 * alternative, is `packages/time/src/zone-canonical.ts`'s and is not re-derived here. What this
 * file enforces is that same rule for `app.config.ts`: an identifier is `Area/Location`, `UTC` is
 * the one legal exception, and a leading sign is an offset rather than a name.
 *
 * It exists because a bare `new Intl.DateTimeFormat(…)` probe was the second answer to that
 * question, and the two stopped agreeing: ICU 78 (Bun 1.4) resolves `CET`, `EST`, `Japan`, `GMT`,
 * `Zulu` and the whole `backward`/abbreviation family, so `defaultTimeZone: 'CET'` passed validation
 * at boot and threw `X_TIMEZONE_INVALID` on the first `format` call — a config file accepting a
 * value nothing downstream can use (issue #257).
 *
 * The judgement is made on the RESOLVED name, not the input, so a casing (`utc`) and a runtime that
 * folds an alias into its target (`Etc/UTC` → `UTC`) both answer correctly. No cache: this is read
 * once per process at config validation, never off a request header — a zone that arrives from a
 * caller goes through `@ultimat3/time`'s `canonicalTimeZone`, which is bounded and canonicalizing.
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
