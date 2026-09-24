// Single responsibility: the one rule deciding whether a STRING is an ISO-8601 date or date-time
// that names an instant on its own. Its own file because the validator, the HTTP coercion and
// `@ultimat3/time`'s `fromIso` have to answer identically — two copies is how they came to disagree.

/**
 * A clock time, and the zone it is stated in. `2026-08-19T10:00` carries the first and not the
 * second, so `new Date` resolves it through the HOST process's zone: the same wire value is
 * `14:00Z` on a `TZ=America/New_York` pod and `10:00Z` on a `TZ=UTC` one, from one request.
 * That is the framework's "no date without an explicit zone, no ambient default anywhere" rule
 * failing at the parse end rather than the format end.
 *
 * A date-only form carries no clock time and is UTC by specification, so it is not this.
 */
const CLOCK_TIME = /[t ]\d{1,2}:\d{2}/i;
const UTC_OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;

/**
 * The ISO-8601 shape, and nothing else. `new Date` also parses `'March 14, 2026'`, `'3/14/2026'`
 * and `'12'` — each at the host's LOCAL midnight, so the instant depended on `TZ`. Case-insensitive
 * because RFC 3339 §5.6 permits a lowercase `t` and `z`.
 */
const ISO_SHAPE =
  /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/i;

/** What a `t.date` string must not be: a clock time with no offset and no `Z`. */
export function isZonelessDateTime(value: string): boolean {
  return CLOCK_TIME.test(value) && !UTC_OFFSET.test(value);
}

/**
 * True when `value` is an ISO-8601 date, or date-time carrying `Z` or an offset: the only strings
 * whose instant is the same on every host. Check it before `new Date(value)`, every time.
 */
export function isIsoDateTime(value: string): boolean {
  return ISO_SHAPE.test(value) && !isZonelessDateTime(value);
}
