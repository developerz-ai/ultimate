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
      {
        route: ctx.route?.meta.rateLimit ?? config.defaultBucket,
        tenant: config.tenantBucket,
      },
    ),
  );
};

/**
 * The `auth` stage's failure path. A request refused 401 never reaches `rate-limit`, so nothing
 * metered it: a caller with no credential, or a wrong one, could ask the credential store about
 * tokens without bound. Spent only on FAILURE and keyed on the address ALONE — a signed-in
 * caller behind the same NAT spends nothing here, and its own bucket stays where it was.
 */
export const spendUnauthenticated = (
  ctx: RequestContext,
  limiter: RateLimiter,
  config: RateLimitConfig,
): Promise<void> => {
  if (!config.enabled) return Promise.resolve();
  return spendAll(ctx, limiter, [
    { key: `${UNAUTHENTICATED_SCOPE}|ip:${ctx.ip ?? 'unknown'}`, bucket: config.defaultBucket },
  ]);
};
