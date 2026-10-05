// A rate-limit decision as the three `RateLimit-*` response headers. One rendering, so the
// pipeline's limiter, a bearer mount's per-token allowance and a primitive's declared bucket can
// never answer a client in two shapes.

import type { RequestContext } from './context';
import type { RateLimitDecision } from './rate-limit';

/**
 * Lowercase names, as every writer sets them on `ctx.headers`. The reset is whole seconds from
 * `nowMs`, floored at 0: a decision read after its own reset passed is a full bucket, not a
 * negative wait.
 */
export const rateLimitHeaders = (
  decision: RateLimitDecision,
  nowMs: number,
): Record<string, string> => ({
  'ratelimit-limit': String(decision.limit),
  'ratelimit-remaining': String(decision.remaining),
  'ratelimit-reset': String(Math.max(0, Math.ceil((decision.resetAtMs - nowMs) / 1000))),
});

/**
 * A handler-spent bucket onto the answer (`RouteMeta.rateLimitedBy: 'handler'`), when it is the
 * one closest to refusing — the rule the `rate-limit` stage follows across its own buckets:
 * `remaining: 118` off the tenant's while the primitive's holds 1 tells a client to proceed and
 * then refuses its next call. A refusal always wins. Set on the CONTEXT before the handler throws,
 * so the `error-map` stage's 429 carries these headers and reads `Retry-After` off `ctx.rateLimit`.
 */
export const publishRateLimit = (
  ctx: RequestContext,
  decision: RateLimitDecision,
  nowMs: number,
): void => {
  const prior = ctx.rateLimit;
  if (decision.allowed && prior !== undefined && prior.remaining < decision.remaining) return;
  ctx.rateLimit = decision;
  for (const [name, value] of Object.entries(rateLimitHeaders(decision, nowMs))) {
    ctx.headers.set(name, value);
  }
};
