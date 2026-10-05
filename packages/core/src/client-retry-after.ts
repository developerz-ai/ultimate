/**
 * A `Retry-After` header off the wire, as the delay a responder named — the one reader core has.
 * `clientTransport` hands it to the decoders, so a browser waits what a 429 or 503 said even when
 * it never loaded the package that registered the code's `retry-after` class.
 */

/**
 * The longest stated delay a client will take at its word: one day. A responder naming a year is a
 * misconfigured proxy, not a schedule, and `retryDecision` still clamps to the policy's own `max`.
 */
export const MAX_RETRY_AFTER_SECONDS = 86_400;

/** RFC 9110 delta-seconds: `1*DIGIT`, nothing else — no sign, no fraction, no exponent. */
const DELTA_SECONDS = /^\d+$/;

/**
 * Seconds to wait, or `undefined` when the header is absent or is neither form. A date is measured
 * against the SAME response's `Date` header — the responder's clock against the responder's clock,
 * so a browser whose clock is an hour off still waits what was meant — and a date with no `Date`
 * beside it (or one a cross-origin response does not expose) is ignored, as is `0` or a past date.
 */
export function retryAfterSecondsOf(
  header: string | null,
  date: string | null,
): number | undefined {
  if (header === null) return undefined;
  const value = header.trim();
  if (DELTA_SECONDS.test(value)) return stated(Number(value));
  // RFC 9110's preferred HTTP-date, IMF-fixdate (`Wed, 21 Oct 2015 07:28:00 GMT`), is exactly what
  // `toUTCString()` writes — so the round trip IS the format check, and it also refuses a day
  // `Date.parse` rolled forward (`31 Feb`) and the two obsolete forms, whose parse is engine-defined.
  const at = Date.parse(value);
  const now = date === null ? Number.NaN : Date.parse(date);
  if (!Number.isFinite(at) || !Number.isFinite(now) || new Date(at).toUTCString() !== value) {
    return undefined;
  }
  return stated(Math.ceil((at - now) / 1_000));
}

/**
 * Only a POSITIVE delay is a statement — the rule `@ultimat3/http`'s `retryAfterOf` applies
 * outbound and realtime's sync protocol applies to `held`. A `0` or a date already past reads as
 * "retry now", which is the stampede: every attempt fires at once and a webhook dead-letters in
 * seconds. Unstated, the caller falls back to its own jittered curve instead.
 */
const stated = (seconds: number): number | undefined =>
  seconds > 0 ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS) : undefined;
