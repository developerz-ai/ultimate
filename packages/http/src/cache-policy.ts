// Single responsibility: what a response may be cached as when neither the handler nor the route
// declared a hint. Split out of `pipeline.ts` because the answer is not the route's alone — the
// actor is half of it, and that is the half a cache bug in this framework would come from.

import type { Actor } from '@ultimat3/core';
import { isAnonymous } from '@ultimat3/core';
import type { CacheHint } from './response';
import type { Route } from './router';

/**
 * Authenticated responses are never shared-cacheable; that default is not overridable.
 *
 * The ACTOR decides it, not `meta.auth` alone. `RouteMeta.auth` is `'public' | 'required'`, and the
 * commonest page in any app — public, but greeting you by name when you are signed in — is
 * `'public'`: keying only off the route handed that signed-in user's personalised HTML to a CDN for
 * 60 seconds, which then served it to everyone else. A request carrying an identity is `private`
 * whatever the route says. The other half is `vary: cookie` on the shared path (`response.ts`);
 * either alone leaves the hole open.
 */
export const defaultCache = (route: Route | undefined, actor: Actor): CacheHint => {
  if (route === undefined || route.meta.auth === 'required') return { mode: 'no-store' };
  if (!isAnonymous(actor)) return { mode: 'private', maxAgeSeconds: 0 };
  return { mode: 'public', maxAgeSeconds: 0, sMaxAgeSeconds: 60, staleWhileRevalidateSeconds: 600 };
};
