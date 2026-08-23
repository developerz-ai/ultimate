// Single responsibility: is an HTTP status worth sending the same request again? One table, because
// `packages/cache/src/purge-http.ts` and `packages/mail/src/driver-resend.ts` shipped the SAME line
// byte for byte in two packages that cannot import each other, and `@ultimat3/ai`'s gateway shipped
// a third, narrower answer (`429 || >= 500`) for the same question.

/**
 * The 4xx that can succeed unchanged. Everything else in the 4xx range is the request's own fault
 * and retrying it only burns the budget.
 *
 * | Status | Why a retry can win |
 * |---|---|
 * | 408 Request Timeout | the server gave up waiting for a body it never fully read; nothing about the request was refused |
 * | 409 Conflict | a concurrent writer won this round — the same write can land once theirs settles |
 * | 425 Too Early | the server refused to risk replay of early data; the same request is fine on a completed handshake |
 * | 429 Too Many Requests | a throttle, and the one 4xx that names WHEN in `Retry-After` |
 */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 409, 425, 429]);

/**
 * `>= 500` is deliberately whole rather than a list. A 501 and a 505 are permanent and a retry
 * wastes one attempt on them; a 500/502/503/504 is the transient case a retry exists for, and
 * splitting the range is a table that must be right about every future status a proxy invents.
 * Both shipped copies drew the line here, so this is their behaviour and not a new one.
 */
export function isRetryableStatus(status: number): boolean {
  return status >= 500 || RETRYABLE_STATUSES.has(status);
}
