// What the pipeline SPENDS, and when: the `rate-limit` stage's list of keys for a request that
// has a caller, and the one allowance the `auth` stage spends for a request that failed to have
// one. Split out of `stages.ts` at the size ceiling; the bucket maths stays in `rate-limit.ts`.

import { actorView, type RequestContext } from './context';
import {
  type RateLimitConfig,
  type RateLimitDecision,
  type RateLimiter,
  type RateLimitSpend,
  rateLimitSpends,
} from './rate-limit';
import { rateLimited } from './rate-limit-errors';

/**
 * The namespace failed credentials are counted in. Not route-scoped, for `TENANT_SCOPE`'s reason:
 * a per-route key would hand one address its whole allowance again on every required route.
 */
export const UNAUTHENTICATED_SCOPE = 'unauthenticated';

/**
 * Spends each key in order and stops at the first refusal, so a caller its own bucket already
 * refused costs its tenant nothing. Recorded on the context BEFORE the throw, so the 429 carries
 * `Retry-After` and the `RateLimit-*` headers rather than making the client guess.
 */
const spendAll = async (
  ctx: RequestContext,
  limiter: RateLimiter,
  spends: readonly RateLimitSpend[],
): Promise<void> => {
  let answer: RateLimitDecision | undefined;
  let refusedKey: string | undefined;
  for (const spend of spends) {
    const decision = await limiter.check(spend.key, spend.bucket);
    // The bucket closest to refusing is the one the caller has to plan against: reporting
    // `remaining: 99` off a per-actor bucket while the tenant's holds 2 is a number that tells a
    // client it may proceed and then refuses its next call.
    if (answer === undefined || decision.remaining < answer.remaining) answer = decision;
    if (!decision.allowed) {
      answer = decision;
      refusedKey = spend.key;
      break;
    }
  }
  if (answer === undefined) return;
  ctx.rateLimit = answer;
  for (const [name, value] of Object.entries(limiter.headers(answer))) {
    ctx.headers.set(name, value);
  }
  if (refusedKey !== undefined) throw rateLimited(refusedKey, answer.retryAfterSeconds);
};

/**
 * The `rate-limit` stage. A LIST, and the second entry is why: the key builder used to pick ONE
 * subject — actor > org > ip, exclusive — so an authenticated request never touched a tenant
 * bucket and one org's 8,000 seats each ran their own allowance against one shared pool.
 */
export const spendRequestBuckets = async (
  ctx: RequestContext,
  limiter: RateLimiter,
  config: RateLimitConfig,
  routeName: string,
): Promise<void> => {
  if (!config.enabled) return;
  const actor = actorView(ctx.actor);
  await spendAll(
    ctx,
    limiter,
    rateLimitSpends(
      { actorId: actor?.id ?? null, orgId: actor?.orgId ?? null, ip: ctx.ip, routeName },
      { route: routeBucketOf(ctx, config), tenant: config.tenantBucket },
    ),
  );
};

/**
 * The ONE place that decides which bucket a route's caller spends here. A route whose handler
 * spends its own declared limit (`rateLimitedBy: 'handler'` — every action and query route, whose
 * primitive counts that limit on every surface) spends none: `default` beside it would cap an
 * action that declared 1,000 at 120, which a declared limit never was.
 */
const routeBucketOf = (ctx: RequestContext, config: RateLimitConfig): string | null => {
  const meta = ctx.route?.meta;
  if (meta?.rateLimitedBy === 'handler') return null;
  return meta?.rateLimit ?? config.defaultBucket;
};

/** The one key failed credentials are counted under: the address alone, never the route. */
const unauthenticatedKey = (ip: string | null): string =>
  `${UNAUTHENTICATED_SCOPE}|ip:${ip ?? 'unknown'}`;

/**
 * The `auth` stage's GATE, before `authenticate()` on a required route: an address whose failure
 * allowance is spent is refused here, a valid credential included. Spending only on failure
 * answered a wrong guess 429 and still served a right one, so it bounded nothing a guesser cares
 * about — and every refused guess was still a credential-store read.
 *
 * READ ONLY: `RateLimitStore.peek`, never a take — this runs on every request to a required route,
 * signed-in ones included, and a zero-cost take was a Postgres upsert on each. The refusal carries
 * the peek's own `Retry-After` (`rateLimitPeek`). With no address there is no key
 * worth refusing on — `ip:unknown` is everyone at once — so the gate stands aside and the failure
 * path below still counts.
 */
export const refuseExhaustedAddress = async (
  ctx: RequestContext,
  limiter: RateLimiter,
  config: RateLimitConfig,
): Promise<void> => {
  if (!config.enabled || ctx.ip === null) return;
  const key = unauthenticatedKey(ctx.ip);
  const peek = await limiter.peek(key, config.defaultBucket);
  if (peek.remaining >= 1) return;
  throw rateLimited(key, peek.retryAfterSeconds);
};

/**
 * The `auth` stage's failure path. A request refused 401 never reaches `rate-limit`, so nothing
 * metered it: a caller with no credential, or a wrong one, could ask the credential store about
 * tokens without bound. Spent only on FAILURE and keyed on the address ALONE — a signed-in
 * caller behind the same NAT spends nothing here. Once it is spent, `refuseExhaustedAddress`
 * refuses that address on required routes, signed-in callers included, until it refills.
 */
export const spendUnauthenticated = (
  ctx: RequestContext,
  limiter: RateLimiter,
  config: RateLimitConfig,
): Promise<void> => {
  if (!config.enabled) return Promise.resolve();
  return spendAll(ctx, limiter, [
    { key: unauthenticatedKey(ctx.ip), bucket: config.defaultBucket },
  ]);
};
