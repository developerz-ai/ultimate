// The actor a route is rendered AS when the render exists only to be weighed. `app/` pages are
// authed by construction: a `load` that calls a policy-guarded query denies an anonymous actor with
// `X_UNAUTHENTICATED`, so under the anonymous build context every authed page was reported
// `X_BUDGET_UNMEASURED` and a real app could not pass the `budgets` step (measured 2026-09-05).
// Weighing bytes needs no data authority — the rendered document is discarded — so this actor holds
// every permission. It is handed ONLY to the weigh-and-discard branch of `prerender.ts`, never to
// `renderStatic`: a `site/` artifact is published to everyone, and a guarded query inside its `load`
// must keep failing the build rather than rendering another actor's rows into a file.

import type { Actor } from '@ultimat3/core';

/** The id every trace and log line under a measurement render carries, so it is recognisable. */
export const MEASUREMENT_ACTOR_ID = 'x-build-measure';

/**
 * `kind: 'service'` and not `'user'`: an app's own `requireMember()`-style helper that resolves a
 * user to a row has nothing to resolve here, and the honest kind says so. `'*'` is the grant
 * `actorHas` reads as everything — the same spelling a role map uses for a superuser.
 */
export const measurementActor = (): Actor => ({
  kind: 'service',
  id: MEASUREMENT_ACTOR_ID,
  roles: [],
  scopes: [],
  permissions: ['*'],
});
