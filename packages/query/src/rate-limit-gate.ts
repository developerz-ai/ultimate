/**
 * Where a read's declared `rateLimit:` is spent: once, in the read path's front half, so the HTTP
 * route, a paged read, the MCP tool and a live subscribe draw on ONE bucket. The store is
 * `@ultimat3/http`'s installed one — the slot `@ultimat3/action`'s `invoke` spends from too.
 */

import type { Actor } from '@ultimat3/core';
import { liveClock, rateLimitScopeOf, rateLimitSpendsOn, rateLimitSubjectOf } from '@ultimat3/core';
import type { RateLimitDecision } from '@ultimat3/http';
// The bucket maths, the subject precedence and the refusal are `@ultimat3/http`'s (tier 2): a copy
// here would be a second answer to "what does this limit mean" and "whose bucket is it".
import { installedRateLimitStore, rateLimited, rateLimitSpends, toBucket } from '@ultimat3/http';
import type { QuerySurface } from './policy-gate';
import type { QueryRateLimit } from './query';

export interface QueryLimitCaller {
  /** Who is reading — `ctx.actor` on a read, the socket's actor on a live subscribe. */
  readonly actor: Actor;
  readonly surface: QuerySurface;
  /** The connection address — the only subject an anonymous reader has. */
  readonly clientAddress?: string | null | undefined;
  /** The decision, before a refusal is thrown: how HTTP puts `RateLimit-*` on the answer. */
  readonly onRateLimit?: ((decision: RateLimitDecision) => void) | undefined;
  /** Epoch ms from the caller's clock. Absent, the system clock. */
  readonly nowMs?: number | undefined;
}

/**
 * Spend one token of a read's declared limit for this caller, or throw `X_RATE_LIMITED`. Called by
 * `read.ts`'s `buildSource` for every enforced build, and through `spendQueryLimit` (`live.ts`) by
 * the one surface this package does not run: realtime's per-subscriber live subscribe.
 *
 * `surface: 'server'` spends nothing — app code reading in-process (a page's render, a service),
 * the rule `@ultimat3/action` applies to its own `'server'` surface. A refused attempt spends
 * nothing either: the token bucket only decrements on an admission.
 */
export async function spendReadLimit(
  name: string,
  limit: QueryRateLimit | undefined,
  caller: QueryLimitCaller,
): Promise<void> {
  if (limit === undefined || !rateLimitSpendsOn(caller.surface)) return;
  const spends = rateLimitSpends(
    {
      // Core's one subject rule, `@ultimat3/action`'s too: an anonymous actor's org is still read.
      ...rateLimitSubjectOf(caller.actor, caller.clientAddress ?? null),
      // Namespaced, never the bare name: the HTTP stage spends `<route name>|<subject>`.
      routeName: rateLimitScopeOf('query', name),
    },
    // The tenant allowance is the HTTP pipeline's; counting it here too would charge twice.
    { route: name, tenant: null },
  );
  const nowMs = caller.nowMs ?? liveClock.now().getTime();
  for (const spend of spends) {
    const decision = await installedRateLimitStore().take(
      spend.key,
      toBucket(name, limit),
      1,
      nowMs,
    );
    caller.onRateLimit?.(decision);
    if (!decision.allowed) throw rateLimited(spend.key, decision.retryAfterSeconds);
  }
}
