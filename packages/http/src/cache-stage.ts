// Single responsibility: the `cache-headers` stage's final answer — the one owner of what a
// response may be cached as. Split out of `stages.ts` when the exchange rule (method + status)
// joined the route default, the declared hint and the review of a handler's own header.

import { isAnonymous } from '@ultimat3/core';
import {
  defaultCache,
  offersSharedCache,
  PRIVATE_CACHE,
  replayableExchange,
  reviewedHint,
} from './cache-policy';
import type { RequestContext } from './context';
import { addVary, applyCacheHeaders, NO_STORE, SHARED_CACHE_VARY } from './response';

export const finalizeCacheHeaders = (response: Response, ctx: RequestContext): void => {
  const declared = response.headers.get('cache-control');
  // The EXCHANGE first, before any hint or declaration: a POST's answer or a refusal is never
  // a shared cache's to replay, whatever the route or the handler offered (`replayableExchange`).
  // `pragma: no-cache` beside it is RFC 6749 §5.1's pair for a token endpoint's answer, and
  // costs nothing anywhere else. Only an OFFER is overruled — a handler's own `private` or
  // `no-store` already says less than this would.
  if (!replayableExchange(ctx.method, response.status)) {
    if (declared === null || offersSharedCache(declared)) {
      applyCacheHeaders(response, NO_STORE);
      if (!response.headers.has('pragma')) response.headers.set('pragma', 'no-cache');
    }
    return;
  }
  if (declared === null) {
    const hint = ctx.cache ?? ctx.route?.meta.cache ?? defaultCache(ctx.route, ctx.actor);
    applyCacheHeaders(response, reviewedHint(hint, ctx.actor));
    return;
  }
  // A declaration is the MODE's intent, never the last word: `@ultimat3/render`'s `ssrHeaders`
  // offers any route without a `policy` to a CDN for 30 seconds, and `meta.auth` is
  // `'public' | 'required'` — so the page that greets a signed-in visitor by name is a
  // `'public'` route whose own header says `s-maxage`. This stage is the one owner of the
  // final answer, which is why it REVIEWS what the handler wrote instead of standing down;
  // the rule beside it was otherwise unreachable for every page route in every app.
  if (!offersSharedCache(declared)) return;
  if (!isAnonymous(ctx.actor)) {
    applyCacheHeaders(response, PRIVATE_CACHE);
    return;
  }
  addVary(response, SHARED_CACHE_VARY);
};
