// Single responsibility: the one rule deciding whether a date-time STRING names an instant on its
// own. Its own file because both the validator and the HTTP coercion have to answer identically —
// two copies of this pair is how the wire path and the validation path came to disagree.

/**
 * A clock time, and the zone it is stated in. `2026-08-19T10:00` carries the first and not the
 * second, so `new Date` resolves it through the HOST process's zone: the same wire value is
 * `14:00Z` on a `TZ=America/New_York` pod and `10:00Z` on a `TZ=UTC` one, from one request.
 * That is the framework's "no date without an explicit zone, no ambient default anywhere" rule
 * failing at the parse end rather than the format end.
 *
 * A date-only form carries no clock time and is UTC by specification, so it is not this.
 *
 * The same pair `@ultimat3/time`'s `fromIso` refuses on, character for character: one wire value,
 * one rule, whichever door it comes through.
 */
const CLOCK_TIME = /[t ]\d{1,2}:\d{2}/i;
const UTC_OFFSET = /(?:z|[+-]\d{2}:?\d{2})$/i;

/** What a `t.date` string must not be: a clock time with no offset and no `Z`. */
export function isZonelessDateTime(value: string): boolean {
  return CLOCK_TIME.test(value) && !UTC_OFFSET.test(value);
}
